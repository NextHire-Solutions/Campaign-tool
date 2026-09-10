import { randomUUID } from "node:crypto";
import { createInstantlyClient } from "@/lib/instantly/client.ts";
import { getSupabase } from "@/lib/supabase/server";

/*
 * Removing leads from an Instantly campaign.
 *
 * Same contract as the EmailBison path (lead-membership.ts): chunked, audited,
 * and honest about partial success. Two things differ, both from the platform:
 *
 *  - `DELETE /leads` takes `{campaign_id, ids}` and answers 200 without saying
 *    how many it acted on. So `applied` is measured the only honest way
 *    available — by counting what is GONE from our own table afterwards, not by
 *    trusting the request size. The EmailBison path does the same thing for the
 *    same reason.
 *  - A move-leads job LOCKS the campaign (409, see the findings doc). That is
 *    reported as the platform's own words rather than retried, because a
 *    removal racing an in-flight move is not something to force through.
 */

/** Ids per request. Large enough to be few calls, small enough to stay inside
 * the 8-second budget every RPC and API call here shares. */
const CHUNK = 500;

export interface InstantlyRemovalResult {
  ok: boolean;
  batchId: string;
  attempted: number;
  /** Verified from our own table, never from the request size. */
  applied: number;
  chunks: Array<{ size: number; ok: boolean; error?: string }>;
  error?: string;
}

export async function removeInstantlyLeads(
  campaignId: string,
  leadIds: string[],
  actor: string,
  teamId: number,
): Promise<InstantlyRemovalResult> {
  const sb = getSupabase();
  const client = createInstantlyClient();
  const batchId = randomUUID();

  const result: InstantlyRemovalResult = {
    ok: false,
    batchId,
    attempted: leadIds.length,
    applied: 0,
    chunks: [],
  };

  const { data: campaign } = await sb
    .from("instantly_campaigns")
    .select("name")
    .eq("id", campaignId)
    .maybeSingle();
  const name = (campaign?.name as string | undefined) ?? campaignId;

  const before = await countRemaining(teamId, campaignId, leadIds);

  for (let i = 0; i < leadIds.length; i += CHUNK) {
    const part = leadIds.slice(i, i + CHUNK);
    try {
      await client.removeLeads(campaignId, part);
      result.chunks.push({ size: part.length, ok: true });
    } catch (error) {
      result.chunks.push({
        size: part.length,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /*
   * OUR CACHE IS UPDATED FIRST, then the count is taken from it. Instantly's
   * own list is eventually consistent right after a delete, so reading it back
   * immediately reports the old number and makes a successful removal look like
   * a no-op.
   */
  const succeeded = result.chunks.filter((c) => c.ok);
  if (succeeded.length) {
    for (let i = 0; i < leadIds.length; i += CHUNK) {
      const part = leadIds.slice(i, i + CHUNK);
      await sb.from("instantly_leads").delete().in("id", part).eq("team_id", teamId);
    }
  }

  const after = await countRemaining(teamId, campaignId, leadIds);
  result.applied = Math.max(before - after, 0);
  result.ok = result.chunks.every((c) => c.ok) && result.applied > 0;
  if (!result.ok) {
    result.error =
      result.chunks.find((c) => !c.ok)?.error ??
      "Instantly accepted the request but no leads left the campaign.";
  }

  await sb.from("campaign_audit_log").insert({
    team_id: teamId,
    // No EmailBison campaign to name; 083 added platform + campaign_ref.
    campaign_id: null,
    platform: "instantly",
    campaign_ref: campaignId,
    campaign_name: name,
    action: "remove-leads",
    actor,
    status: result.ok ? "ok" : "error",
    error: result.error ?? null,
    before_state: { attempted: result.attempted, present: before },
    after_state: { applied: result.applied, remaining: after },
    batch_id: batchId,
  });

  return result;
}

/** How many of these ids are still on the campaign, per our own table. */
async function countRemaining(
  teamId: number,
  campaignId: string,
  leadIds: string[],
): Promise<number> {
  let total = 0;
  // Chunked because a `.in()` of 20,000 uuids exceeds the URL length PostgREST
  // will accept, and a truncated filter would undercount silently.
  for (let i = 0; i < leadIds.length; i += CHUNK) {
    const { count } = await getSupabase()
      .from("instantly_leads")
      .select("id", { count: "exact", head: true })
      .eq("team_id", teamId)
      .eq("campaign_id", campaignId)
      .in("id", leadIds.slice(i, i + CHUNK));
    total += count ?? 0;
  }
  return total;
}
