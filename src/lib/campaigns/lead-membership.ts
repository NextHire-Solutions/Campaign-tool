import { randomUUID } from "node:crypto";
import { createEmailBisonClient } from "@/lib/emailbison/client.ts";
import { describeEmailBisonError, invalidIndices } from "@/lib/emailbison/errors.ts";
import { getSupabase } from "@/lib/supabase/server";

/*
 * Adding and removing a campaign's leads.
 *
 * Both directions change what real prospects receive, so both follow the rules
 * campaign actions already established: the caller is named in the audit log,
 * EmailBison is the authority, and nothing reports success it did not get.
 *
 * BATCHED, BECAUSE THE SELECTION CAN BE THOUSANDS. "Remove every lead that
 * never replied" on campaign 55 is ~6,000 ids. One request with 6,000 ids is a
 * request that times out halfway with no way to know what it did. Chunks are
 * small enough to succeed and are reported per chunk, so a partial failure
 * names exactly how far it got.
 *
 * SERIAL, NOT PARALLEL. These mutate one campaign's membership; firing chunks
 * concurrently at the same campaign invites the API to interleave them, and a
 * half-applied membership is not something you can diff afterwards.
 */

/**
 * Ids per request.
 *
 * EmailBison documents no cap. 500 is chosen to be obviously safe rather than
 * optimal: at 6,000 leads that is 12 calls, which costs a couple of seconds and
 * removes the failure mode where one oversized request dies and leaves the
 * campaign in a state nobody can describe.
 */
const CHUNK = 500;

export interface MembershipResult {
  ok: boolean;
  /** Ids we asked EmailBison to act on. */
  attempted: number;
  /**
   * What actually changed, measured as the campaign's own lead count before vs
   * after — NOT the number of ids we sent.
   *
   * EmailBison answers an attach with `success: true` and then silently drops
   * leads it will not accept. Verified: attaching three leads to a campaign
   * added two, because the third was `status: bounced`, and the response said
   * "Leads successfully added" either way. Reporting the requested count as the
   * applied count would mean telling someone 4,000 leads moved when 3,100 did.
   */
  applied: number;
  /** attempted − applied: ids EmailBison accepted the request for but did not act on. */
  skipped: number;
  chunks: Array<{ size: number; ok: boolean; message?: string; error?: string }>;
  batchId: string;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function audit(
  action: string,
  campaignId: number,
  teamId: number,
  actor: string,
  batchId: string,
  result: MembershipResult,
  extra: Record<string, unknown> = {},
) {
  const sb = getSupabase();
  const { data: campaign } = await sb
    .from("campaigns")
    .select("name")
    .eq("id", campaignId)
    .maybeSingle();

  await sb.from("campaign_audit_log").insert({
    team_id: teamId,
    campaign_id: campaignId,
    campaign_name: campaign?.name ?? `#${campaignId}`,
    action,
    actor,
    status: result.ok ? "ok" : "error",
    error: result.ok ? null : result.chunks.find((c) => !c.ok)?.error ?? "partial failure",
    before_state: { attempted: result.attempted, ...extra },
    after_state: { applied: result.applied },
    batch_id: batchId,
  });
}

/**
 * Removes leads from a campaign, then records it locally.
 *
 * THE LOCAL MARKER IS NOT OPTIONAL. campaign_leads is derived from send
 * history, so without `removed_at` the next sync recomputes every removed lead
 * straight back onto the screen — see migration 065. The send history itself is
 * deliberately left alone: removal stops future emails, it does not unsend the
 * ones already sent, and deleting those rows would rewrite the campaign's past.
 */
export async function removeLeads(
  campaignId: number,
  leadIds: number[],
  actor: string,
  teamId: number,
): Promise<MembershipResult> {
  const eb = createEmailBisonClient();
  const batchId = randomUUID();
  const result: MembershipResult = {
    ok: true,
    attempted: leadIds.length,
    applied: 0,
    skipped: 0,
    chunks: [],
    batchId,
  };

  // The count before, so `applied` can be measured rather than assumed.
  const before = await eb.getCampaignLeadCount(campaignId);
  const applied: number[] = [];

  for (const part of chunk(leadIds, CHUNK)) {
    /*
     * ONE RETRY, WITHOUT THE IDS EMAILBISON NAMED.
     *
     * This DELETE is all-or-nothing: a single id that is not currently attached
     * refuses the whole batch and removes nothing. A selection made on screen
     * goes stale easily — someone else removed a lead, or a previous run
     * already did — and without this a 500-id chunk fails entirely because of
     * one. The 422 names the offending array indices, so they can be dropped
     * exactly and the remainder retried.
     *
     * Deliberately ONE retry, not a loop: the second attempt has already been
     * told every invalid index, so a second failure is a different problem and
     * retrying again would just be guessing.
     */
    let batch = part;
    let attempt = 0;

    for (;;) {
      try {
        const response = await eb.removeLeadsFromCampaign(campaignId, batch);
        result.chunks.push({
          size: batch.length,
          ok: true,
          message: response?.data?.message,
        });
        applied.push(...batch);
        break;
      } catch (error) {
        const bad = invalidIndices(error, "lead_ids");
        if (bad.length && attempt === 0 && bad.length < batch.length) {
          // Those ids are not on this campaign, which is the outcome the caller
          // wanted anyway. Drop them and remove the rest.
          const drop = new Set(bad);
          batch = batch.filter((_, i) => !drop.has(i));
          attempt++;
          continue;
        }
        result.ok = false;
        result.chunks.push({
          size: batch.length,
          ok: false,
          error: describeEmailBisonError(error),
        });
        // Keep going. A chunk refusing says nothing about the next, and stopping
        // would leave the caller unable to say which leads are still attached.
        break;
      }
    }
  }

  const after = await eb.getCampaignLeadCount(campaignId);
  result.applied = Math.max(0, before - after);
  result.skipped = Math.max(0, result.attempted - result.applied);

  /*
   * Marked only for the ids in chunks EmailBison accepted. Marking the whole
   * selection would claim a removal that did not happen, and the screen would
   * disagree with the campaign.
   */
  if (applied.length) {
    const sb = getSupabase();
    const stamp = new Date().toISOString();
    for (const part of chunk(applied, 1000)) {
      await sb
        .from("campaign_leads")
        .update({ removed_at: stamp, removed_by: actor })
        .eq("campaign_id", campaignId)
        .in("lead_id", part);
    }
  }

  await audit("remove-leads", campaignId, teamId, actor, batchId, result);
  return result;
}

/**
 * Adds existing leads to a campaign.
 *
 * CLEARS `removed_at` for exactly the ids attached. A lead removed once and
 * legitimately added back would otherwise stay hidden behind the Removed facet
 * for ever, and the campaign would be sending to someone the screen says is
 * gone — the one disagreement between us and EmailBison that must not happen.
 */
export async function attachLeads(
  campaignId: number,
  leadIds: number[],
  actor: string,
  teamId: number,
  extra: Record<string, unknown> = {},
): Promise<MembershipResult> {
  const eb = createEmailBisonClient();
  const batchId = randomUUID();
  const result: MembershipResult = {
    ok: true,
    attempted: leadIds.length,
    applied: 0,
    skipped: 0,
    chunks: [],
    batchId,
  };

  const before = await eb.getCampaignLeadCount(campaignId);
  const applied: number[] = [];

  for (const part of chunk(leadIds, CHUNK)) {
    try {
      const response = await eb.attachLeadsToCampaign(campaignId, part);
      result.chunks.push({
        size: part.length,
        ok: true,
        message: response?.data?.message,
      });
      applied.push(...part);
    } catch (error) {
      result.ok = false;
      result.chunks.push({
        size: part.length,
        ok: false,
        error: describeEmailBisonError(error),
      });
    }
  }

  const after = await eb.getCampaignLeadCount(campaignId);
  result.applied = Math.max(0, after - before);
  result.skipped = Math.max(0, result.attempted - result.applied);

  if (applied.length) {
    const sb = getSupabase();
    for (const part of chunk(applied, 1000)) {
      await sb
        .from("campaign_leads")
        .update({ removed_at: null, removed_by: null })
        .eq("campaign_id", campaignId)
        .in("lead_id", part);
    }
  }

  await audit("attach-leads", campaignId, teamId, actor, batchId, result, extra);
  return result;
}
