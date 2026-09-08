import { randomUUID } from "node:crypto";
import { createEmailBisonClient } from "@/lib/emailbison/client.ts";
import { describeEmailBisonError } from "@/lib/emailbison/errors.ts";
import { getSupabase } from "@/lib/supabase/server";

/*
 * Attaching a pool of inboxes to campaigns by tag.
 *
 * "Nicole Pool → Client A's campaigns" is 534 inboxes against however many
 * campaigns, which is why this is a fan-out with per-campaign results rather
 * than a single call that either works or does not.
 *
 * THE TAGS COME FROM OUR CACHE, THE WRITE GOES TO EMAILBISON. sender_emails
 * already carries every inbox's tags (stored by sync-senders), so choosing the
 * pool costs no API calls at all — only the attach does.
 */

/** Ids per request. The estate's largest pool is 534; three calls, not one. */
const CHUNK = 250;

export interface InboxAssignmentResult {
  campaignId: number;
  name: string;
  ok: boolean;
  /** Inboxes EmailBison confirmed for this campaign. */
  applied: number;
  /** Of those, how many were already attached before this run. */
  alreadyAttached?: number;
  error?: string;
}

export interface AssignmentSummary {
  batchId: string;
  tag: string;
  action: "attach" | "remove";
  /** Connected inboxes carrying the tag — what was actually sent. */
  inboxes: number;
  /** Tagged but not Connected, so deliberately left out. */
  skippedDisconnected: number;
  results: InboxAssignmentResult[];
}

/**
 * Is this refusal actually the outcome we wanted?
 *
 * EmailBison answers an attach whose inboxes are all already on the campaign
 * with `success: false` and "These emails already exist on this campaign",
 * which assertApplied correctly turns into an error — for a genuine write, a
 * `success: false` body IS a failure and trusting the 200 would hide it.
 *
 * But re-assigning a pool is a normal thing to do: adding one more campaign to
 * a pool you already assigned, or re-running after fixing a different campaign
 * in the same batch. The end state is exactly what was asked for, so reporting
 * it as a failure would train people to ignore the failure count — which is
 * the one number that has to stay meaningful.
 *
 * Matched narrowly on EmailBison's own wording so a real refusal cannot slip
 * through: anything else is still an error.
 */
function isAlreadyAttached(error: unknown): boolean {
  const message = describeEmailBisonError(error).toLowerCase();
  return message.includes("already exist");
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Attaches (or removes) every inbox carrying `tag` to each campaign.
 *
 * DISCONNECTED INBOXES ARE EXCLUDED FROM AN ATTACH, and the count is reported
 * rather than quietly folded in. An inbox that is not Connected cannot send;
 * attaching it adds a name to a campaign that will never carry a message, and
 * "534 inboxes assigned" would then be a claim about capacity that is false by
 * however many are dead. Removal has no such filter — a dead inbox that is
 * already attached is exactly the thing you want to be able to take off.
 */
export async function assignInboxesByTag(
  campaignIds: number[],
  tag: string,
  action: "attach" | "remove",
  actor: string,
  teamId: number,
): Promise<AssignmentSummary> {
  const sb = getSupabase();
  const eb = createEmailBisonClient();
  const batchId = randomUUID();

  /*
   * IN SQL, RETURNING ONE ROW HOLDING AN ARRAY. This started as a PostgREST
   * `.select()` and was silently capped at 1,000 rows against an estate of
   * 1,496 (rule 7) — so a pool larger than that would have had exactly 1,000
   * inboxes attached and reported success. The RPC also does the
   * connected-only filter, so the two lists cannot drift.
   *
   * `tags @> ARRAY[tag]` is containment over the whole element: "Nicole Pool"
   * must not pick up "Nicole Pool 2", a different pool of 316.
   */
  const [{ data: usableIds, error }, { data: allIds, error: allError }] =
    await Promise.all([
      sb.rpc("sender_ids_by_tag", {
        p_team_id: teamId,
        p_tag: tag,
        p_connected_only: action === "attach",
      }),
      sb.rpc("sender_ids_by_tag", {
        p_team_id: teamId,
        p_tag: tag,
        p_connected_only: false,
      }),
    ]);

  if (error) throw new Error(`inbox lookup: ${error.message}`);
  if (allError) throw new Error(`inbox lookup: ${allError.message}`);

  const inboxIds = (usableIds ?? []) as number[];
  const allTagged = (allIds ?? []) as number[];

  const summary: AssignmentSummary = {
    batchId,
    tag,
    action,
    inboxes: inboxIds.length,
    skippedDisconnected: allTagged.length - inboxIds.length,
    results: [],
  };

  if (!inboxIds.length) return summary;

  const { data: campaignRows } = await sb
    .from("campaigns")
    .select("id, name")
    .eq("team_id", teamId)
    .in("id", campaignIds);
  const nameById = new Map((campaignRows ?? []).map((c) => [c.id, c.name as string]));

  const auditRows: Record<string, unknown>[] = [];

  /*
   * SERIAL over campaigns. Each one is up to three chunked writes against the
   * same workspace, and running them concurrently buys a few seconds in
   * exchange for several half-assigned campaigns when the API starts refusing.
   * The same reasoning as bulk-deploy.
   */
  for (const campaignId of campaignIds) {
    const name = nameById.get(campaignId) ?? `#${campaignId}`;
    const result: InboxAssignmentResult = { campaignId, name, ok: true, applied: 0 };

    for (const part of chunk(inboxIds, CHUNK)) {
      try {
        if (action === "attach") await eb.attachSenderEmails(campaignId, part);
        else await eb.removeSenderEmails(campaignId, part);
        result.applied += part.length;
      } catch (caught) {
        if (action === "attach" && isAlreadyAttached(caught)) {
          // Already on the campaign. That is the requested end state, so it
          // counts, and the next chunk may still have work to do.
          result.applied += part.length;
          result.alreadyAttached = (result.alreadyAttached ?? 0) + part.length;
          continue;
        }
        result.ok = false;
        result.error = describeEmailBisonError(caught);
        // Stop this campaign, continue to the next. A campaign that refuses
        // says nothing about the others, and pressing on with its remaining
        // chunks would just repeat the same refusal.
        break;
      }
    }

    summary.results.push(result);
    auditRows.push({
      team_id: teamId,
      campaign_id: campaignId,
      campaign_name: name,
      action: action === "attach" ? "attach-inboxes" : "remove-inboxes",
      actor,
      status: result.ok ? "ok" : "error",
      error: result.error ?? null,
      before_state: { tag, inboxes: inboxIds.length },
      after_state: result.ok ? { applied: result.applied } : null,
      batch_id: batchId,
    });
  }

  if (auditRows.length) await sb.from("campaign_audit_log").insert(auditRows);

  return summary;
}

/** The inbox tags worth offering, read from the cache. */
export async function listInboxTags(
  teamId: number,
): Promise<Array<{ tag: string; inboxes: number; connected: number }>> {
  /*
   * Counted in SQL. Doing it in JS over a `.select()` reported "Nicole Pool:
   * 269" against a true 534, because the select stopped at 1,000 of 1,496 rows
   * without saying so — plausible enough to ship, wrong enough to matter.
   */
  const { data, error } = await getSupabase().rpc("analytics_inbox_tags", {
    p_team_id: teamId,
  });
  if (error) throw new Error(`tag lookup: ${error.message}`);
  return (data ?? []) as Array<{ tag: string; inboxes: number; connected: number }>;
}
