import { randomUUID } from "node:crypto";
import { createEmailBisonClient } from "@/lib/emailbison/client.ts";
import { createInstantlyClient } from "@/lib/instantly/client.ts";
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
  campaignId: string;
  platform: "emailbison" | "instantly";
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
/**
 * The Instantly half — assigned BY TAG, not by a list of addresses.
 *
 * WHY NOT `email_list`. Instantly has two independent ways to give a campaign
 * its inboxes: `email_list`, a frozen array of addresses, and `email_tag_list`,
 * the pool assignment. Measured on this workspace, every campaign with real
 * send volume uses the second and has the first empty — Howe Realty, Camelot,
 * C21 all carry the "Nicole Pool" tag and no explicit addresses.
 *
 * That matters because a tag stays LIVE. Assign "Nicole Pool" and the campaign
 * sends from whatever that pool holds today; add 20 inboxes to it next month
 * and they apply on their own. Expanding the pool into 428 addresses instead
 * pins a copy that is wrong the first time the pool changes, and nothing would
 * say so.
 *
 * So this writes one tag id rather than 428 addresses. The read-modify-write is
 * still required — a campaign can carry SEVERAL pools (Howe Realty campaigns
 * carry two) and writing only the tag being assigned would detach the others.
 * Verified on a throwaway campaign: `email_list` and `email_tag_list` are
 * independent, so this cannot disturb a campaign deliberately pinned to
 * specific addresses.
 *
 * Serial for the same reason as the EmailBison side: a whole-array replace has
 * no merge semantics, so two concurrent writes to one campaign lose one of them.
 */
async function assignInstantly(
  campaignIds: string[],
  tag: string,
  poolSize: number,
  action: "attach" | "remove",
  nameById: Map<string, string>,
): Promise<InboxAssignmentResult[]> {
  const client = createInstantlyClient();
  const results: InboxAssignmentResult[] = [];

  /*
   * Resolve the pool NAME to the id `email_tag_list` holds, once for the batch.
   *
   * A tag that exists on EmailBison but not on Instantly is a normal thing to
   * pick — the two estates have different pools — so this is reported per
   * campaign rather than thrown. Silently writing nothing would be the bad
   * outcome: the dialog would say it assigned a pool that was never applied.
   */
  let tagId: string | undefined;
  try {
    tagId = (await client.getCustomTagIds()).get(tag.trim().toLowerCase());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return campaignIds.map((campaignId) => ({
      campaignId,
      platform: "instantly" as const,
      name: nameById.get(campaignId) ?? campaignId,
      ok: false,
      applied: 0,
      error: `Could not read Instantly's tags: ${message}`,
    }));
  }

  if (!tagId) {
    return campaignIds.map((campaignId) => ({
      campaignId,
      platform: "instantly" as const,
      name: nameById.get(campaignId) ?? campaignId,
      ok: false,
      applied: 0,
      error: `No Instantly inbox tag named "${tag}". The pools differ per platform.`,
    }));
  }

  for (const campaignId of campaignIds) {
    const name = nameById.get(campaignId) ?? campaignId;
    try {
      const current = await client.getCampaignInboxTags(campaignId);
      const had = current.includes(tagId);

      const next =
        action === "attach"
          ? had
            ? current
            : [...current, tagId]
          : current.filter((id) => id !== tagId);

      const changed = action === "attach" ? !had : had;
      if (changed) await client.setCampaignInboxTags(campaignId, next);

      /*
       * `applied` is the POOL SIZE, not 1.
       *
       * The number is read by a person asking "how many inboxes now send for
       * this campaign", and the honest answer for a tag assignment is the size
       * of the pool it points at. Reporting 1 — the number of fields written —
       * would be true about the API call and useless about the outcome.
       *
       * Zero when nothing changed, so re-running a batch to fix one campaign
       * does not claim to have reassigned the others.
       */
      results.push({
        campaignId,
        platform: "instantly",
        name,
        ok: true,
        applied: changed ? poolSize : 0,
        alreadyAttached: action === "attach" && had ? poolSize : undefined,
      });
    } catch (error) {
      results.push({
        campaignId,
        platform: "instantly",
        name,
        ok: false,
        applied: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

export async function assignInboxesByTag(
  targets: Array<{ platform: "emailbison" | "instantly"; id: string }>,
  tag: string,
  action: "attach" | "remove",
  actor: string,
  teamId: number,
): Promise<AssignmentSummary> {
  const sb = getSupabase();
  const eb = createEmailBisonClient();
  const batchId = randomUUID();

  const ebIds = targets.filter((t) => t.platform === "emailbison").map((t) => Number(t.id));
  const instantlyIds = targets.filter((t) => t.platform === "instantly").map((t) => t.id);
  const campaignIds = ebIds;

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

  /*
   * THE INSTANTLY POOL IS COUNTED SEPARATELY, AND EARLY.
   *
   * The two estates have different pools: "Howe Realty" is 48 Instantly
   * accounts and no EmailBison senders at all. Counting only the EmailBison
   * side and returning when it is empty made an Instantly-only tag a silent
   * no-op — the dialog reported success having assigned nothing, because the
   * function returned before it ever reached the Instantly half.
   *
   * So the pool is resolved per platform and the work is skipped per platform,
   * never for the batch on the strength of one side's count.
   */
  let instantlyPool = 0;
  if (instantlyIds.length) {
    const { data: emails, error: instError } = await sb.rpc(
      "instantly_account_emails_by_tag",
      { p_team_id: teamId, p_tag: tag },
    );
    if (instError) throw new Error(`inbox lookup: ${instError.message}`);
    instantlyPool = ((emails ?? []) as string[]).length;
  }

  const summary: AssignmentSummary = {
    batchId,
    tag,
    action,
    /*
     * The pool actually in play. The dialog assigns one platform at a time, so
     * in practice this is that platform's count; a mixed batch can only come
     * from the API, and there the sum is the truthful total.
     */
    inboxes: (campaignIds.length ? inboxIds.length : 0) + instantlyPool,
    skippedDisconnected: allTagged.length - inboxIds.length,
    results: [],
  };

  // Nothing to assign on EITHER side — only then is there no work.
  if (!inboxIds.length && !instantlyPool) return summary;

  /*
   * Names from the unified view, so one lookup covers both platforms and a
   * result row can never be labelled with the wrong campaign's name.
   */
  const { data: campaignRows } = await sb
    .from("campaigns_unified")
    .select("id, name")
    .eq("team_id", teamId)
    .in("id", targets.map((t) => t.id));
  const nameById = new Map(
    (campaignRows ?? []).map((c) => [String(c.id), c.name as string]),
  );

  const auditRows: Record<string, unknown>[] = [];

  /*
   * SERIAL over campaigns. Each one is up to three chunked writes against the
   * same workspace, and running them concurrently buys a few seconds in
   * exchange for several half-assigned campaigns when the API starts refusing.
   * The same reasoning as bulk-deploy.
   */
  /*
   * Skipped entirely when the tag has no EmailBison senders — an Instantly-only
   * pool paired with EmailBison campaigns. Looping anyway would chunk an empty
   * array, write nothing, and report every campaign as a success with 0
   * applied, which reads as "done" for work that never happened.
   */
  const ebCampaigns = inboxIds.length ? campaignIds : [];
  for (const campaignId of ebCampaigns) {
    const name = nameById.get(String(campaignId)) ?? `#${campaignId}`;
    const result: InboxAssignmentResult = {
      campaignId: String(campaignId),
      platform: "emailbison",
      name,
      ok: true,
      applied: 0,
    };

    /*
     * A REMOVE MAY ONLY SEND IDS THE CAMPAIGN ACTUALLY HAS.
     *
     * EmailBison rejects a remove chunk OUTRIGHT if any id in it is not on the
     * campaign — "The selected sender_email_ids.101 is invalid" — and the whole
     * chunk then removes nothing. Measured: removing a 534-inbox pool from a
     * campaign carrying 531 of them (the 3 disconnected were never attached,
     * because an attach excludes them) took the second chunk down and left 282
     * inboxes stranded, reported as an error.
     *
     * The mismatch is not exotic, it is the NORMAL case: attach uses the
     * connected-only pool and remove used every tagged inbox, so any pool with
     * a single dead inbox in it could not be removed cleanly.
     *
     * So the pool is intersected with what the campaign holds. One paginated
     * read per campaign, on removes only — attach needs no such read because
     * "already attached" is a tolerated outcome, not a refusal.
     */
    let ids = inboxIds;
    if (action === "remove") {
      try {
        const attached = await eb.getCampaignSenderEmails(campaignId);
        const have = new Set(attached.map((s) => s.id));
        ids = inboxIds.filter((senderId) => have.has(senderId));
      } catch (caught) {
        result.ok = false;
        result.error = `Could not read the campaign's current inboxes: ${describeEmailBisonError(caught)}`;
        summary.results.push(result);
        auditRows.push({
          team_id: teamId,
          campaign_id: campaignId,
          platform: "emailbison",
          campaign_ref: String(campaignId),
          campaign_name: name,
          action: "remove-inboxes",
          actor,
          status: "error",
          error: result.error,
          before_state: { tag, inboxes: inboxIds.length },
          after_state: null,
          batch_id: batchId,
        });
        continue;
      }
      // Nothing from this pool is on this campaign: the requested end state
      // already holds, so it is a success with nothing applied.
      if (!ids.length) {
        summary.results.push(result);
        continue;
      }
    }

    for (const part of chunk(ids, CHUNK)) {
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
      platform: "emailbison",
      campaign_ref: String(campaignId),
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

  /*
   * Instantly, after EmailBison rather than beside it. The two use different
   * inbox pools (534 tagged Instantly accounts vs EmailBison's own), and
   * running them concurrently would interleave their audit rows for no gain —
   * the whole operation is already serial per campaign by design.
   */
  if (instantlyIds.length) {
    /*
     * `instantlyPool` was counted above, before the early return, because that
     * count is what decides whether there is Instantly work to do at all. It is
     * passed rather than re-read: the pool is no longer SENT — the assignment
     * is the tag itself — and the size exists only so a result row can say how
     * many inboxes a campaign gained instead of "1 tag written".
     */
    const instResults = await assignInstantly(
      instantlyIds,
      tag,
      instantlyPool,
      action,
      nameById,
    );
    summary.results.push(...instResults);

    for (const r of instResults) {
      auditRows.push({
        team_id: teamId,
        // No EmailBison campaign to name — 083 added platform + campaign_ref.
        campaign_id: null,
        platform: "instantly",
        campaign_ref: r.campaignId,
        campaign_name: r.name,
        action: action === "attach" ? "attach-inboxes" : "remove-inboxes",
        actor,
        status: r.ok ? "ok" : "error",
        error: r.error ?? null,
        // `assigned_by: "tag"` so a future reader can tell these rows apart
        // from the earlier ones written while Instantly used an explicit list.
        before_state: { tag, inboxes: instantlyPool, assigned_by: "tag" },
        after_state: r.ok ? { applied: r.applied } : null,
        batch_id: batchId,
      });
    }
  }

  if (auditRows.length) await sb.from("campaign_audit_log").insert(auditRows);

  return summary;
}

/** The inbox tags worth offering, read from the cache. */
export async function listInboxTags(
  teamId: number,
  platform: "emailbison" | "instantly" = "emailbison",
): Promise<Array<{ tag: string; inboxes: number; connected: number }>> {
  if (platform === "instantly") {
    const { data, error } = await getSupabase().rpc("analytics_instantly_inbox_tags", {
      p_team_id: teamId,
    });
    if (error) throw new Error(`tag lookup: ${error.message}`);
    return (data ?? []) as Array<{ tag: string; inboxes: number; connected: number }>;
  }
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
