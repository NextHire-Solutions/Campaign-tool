import { randomUUID } from "node:crypto";
import { createEmailBisonClient } from "@/lib/emailbison/client.ts";
import { describeEmailBisonError } from "@/lib/emailbison/errors.ts";
import { getSupabase } from "@/lib/supabase/server";
import { createInstantlyClient } from "@/lib/instantly/client.ts";
import { canApply, platformSupports, whyNot, type CampaignAction } from "./status.ts";

/*
 * Applying campaign actions.
 *
 * Three rules, all from spec §9 ("every action is deliberate, confirmed, and
 * recorded") and §9.5 ("if a change can't be applied on the sending platform,
 * the dashboard says so with the actual reason, and does not show the change as
 * saved"):
 *
 *  1. EmailBison decides. The local row is updated only AFTER a 2xx, so the UI
 *     can never show a state the sending platform doesn't have.
 *  2. Every attempt is logged, including failures — a refused pause is exactly
 *     the event someone will come looking for.
 *  3. A bulk action is a fan-out that reports PER ITEM. Pause, resume and
 *     archive have no bulk endpoint, so "23 of 25 paused" is the honest answer
 *     and a single ok/failed for the batch is not.
 */

export type Platform = "emailbison" | "instantly";

/** A campaign, named unambiguously. An id alone spans two id spaces. */
export interface CampaignTarget {
  platform: Platform;
  id: string;
}

export interface ActionResult {
  /** Text, because Instantly campaigns are uuid-keyed. */
  campaignId: string;
  platform: Platform;
  name: string;
  ok: boolean;
  /** Present on success — what EmailBison reports the status is now. */
  status?: string;
  /** Present on failure — the platform's actual words, never a generic message. */
  error?: string;
  /** True when the action was refused locally and never reached EmailBison. */
  skipped?: boolean;
}

interface CampaignRow {
  id: string;
  platform: Platform;
  name: string;
  status: string;
  total_leads: number | null;
}

/** The inverse of the view's status translation, for writing back. */
const INSTANTLY_STATUS_CODE: Record<string, number> = {
  draft: 0,
  active: 1,
  paused: 2,
  completed: 3,
};

/** Status after each action, when EmailBison doesn't return the campaign. */
const RESULTING_STATUS: Record<CampaignAction, string | null> = {
  pause: "paused",
  // resume returns the campaign, so this is only a fallback; `queued` is what
  // it was observed to produce, NOT the previous status.
  resume: "queued",
  archive: "archived",
  duplicate: null, // the source campaign is unchanged
};

async function applyOne(
  eb: ReturnType<typeof createEmailBisonClient>,
  instantly: ReturnType<typeof createInstantlyClient> | null,
  action: CampaignAction,
  campaign: CampaignRow,
): Promise<{ result: ActionResult; after: string | null }> {
  /*
   * Platform first, status second. "Archive is not a thing on Instantly" is a
   * different refusal from "this campaign is already archived", and reporting
   * the second when the first is true sends someone looking for a status
   * problem that does not exist.
   */
  if (!platformSupports(action, campaign.platform)) {
    return {
      result: {
        campaignId: campaign.id,
        platform: campaign.platform,
        name: campaign.name,
        ok: false,
        skipped: true,
        error: `Instantly has no ${action} — the API offers no equivalent, and setting a local flag would show a change that never reached the platform`,
      },
      after: null,
    };
  }

  if (!canApply(action, campaign.status)) {
    // Refused here rather than sent and rejected: a round trip that we already
    // know will fail is a round trip that might instead unexpectedly succeed.
    return {
      result: {
        campaignId: campaign.id,
        platform: campaign.platform,
        name: campaign.name,
        ok: false,
        skipped: true,
        error: whyNot(action, campaign.status),
      },
      after: null,
    };
  }

  try {
    let status: string | null = RESULTING_STATUS[action];

    if (campaign.platform === "instantly") {
      if (!instantly) throw new Error("Instantly is not configured");
      switch (action) {
        case "pause":
          await instantly.pauseCampaign(campaign.id);
          break;
        case "resume":
          // Guarded upstream: the route refuses resume without confirm.
          await instantly.activateCampaign(campaign.id);
          status = "active";
          break;
        case "duplicate":
          await instantly.duplicateCampaign(campaign.id);
          break;
        case "archive":
          // Unreachable: platformSupports already refused it above.
          throw new Error("archive is not supported on Instantly");
      }
    } else {
      const id = Number(campaign.id);
      switch (action) {
        case "pause":
          await eb.pauseCampaign(id);
          break;
        case "resume": {
          const response = await eb.resumeCampaign(id);
          status = response?.data?.status ?? status;
          break;
        }
        case "archive":
          await eb.archiveCampaign(id);
          break;
        case "duplicate":
          await eb.duplicateCampaign(id);
          break;
      }
    }

    return {
      result: {
        campaignId: campaign.id,
        platform: campaign.platform,
        name: campaign.name,
        ok: true,
        status: status ?? undefined,
      },
      after: action === "duplicate" ? null : status,
    };
  } catch (error) {
    // The platform's own words — §9.5 requires the actual reason, and
    // EmailBison nests it under `data`.
    /*
     * The platform's own words. describeEmailBisonError unwraps EmailBison's
     * nested shape; Instantly's client already puts its API's sentence first,
     * so passing it through that unwrapper would lose it.
     */
    const message =
      campaign.platform === "instantly"
        ? error instanceof Error
          ? error.message
          : String(error)
        : describeEmailBisonError(error);

    return {
      result: {
        campaignId: campaign.id,
        platform: campaign.platform,
        name: campaign.name,
        ok: false,
        error: message,
      },
      after: null,
    };
  }
}

/**
 * Applies one action to many campaigns.
 *
 * Concurrency 4 matches the EmailBison rate limiter the read jobs use — a bulk
 * pause over 90 campaigns should not be the thing that gets the API key
 * throttled mid-sweep.
 */
export async function applyCampaignAction(
  action: CampaignAction,
  targets: CampaignTarget[],
  actor: string,
  teamId: number,
): Promise<{ batchId: string; results: ActionResult[] }> {
  const sb = getSupabase();
  const eb = createEmailBisonClient();
  /*
   * Built only when an Instantly campaign is actually in the batch. The
   * constructor throws without an API key, and an all-EmailBison action should
   * not fail because Instantly is unconfigured.
   */
  const needsInstantly = targets.some((t) => t.platform === "instantly");
  const instantly = needsInstantly ? createInstantlyClient() : null;
  const batchId = randomUUID();

  /*
   * ONE read from the unified view, so a campaign's status and platform come
   * from the same row. Reading the two tables separately would mean two id
   * spaces to reconcile in JS, which is where an id-collision bug would live.
   */
  const { data: rows } = await sb
    .from("campaigns_unified")
    .select("id, platform, name, status, total_leads")
    .eq("team_id", teamId)
    .in("id", targets.map((t) => t.id));

  // Keyed by platform AND id: the two id spaces are separate, and a bare id is
  // not a unique key across them.
  const key = (platform: string, id: string) => `${platform}:${id}`;
  const byId = new Map(
    (rows ?? []).map((r) => [key(String(r.platform), String(r.id)), r as CampaignRow]),
  );

  const results: ActionResult[] = [];
  const auditRows: Record<string, unknown>[] = [];
  const statusWrites: Array<{ platform: Platform; id: string; status: string }> = [];

  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, targets.length) }, async () => {
      while (cursor < targets.length) {
        const target = targets[cursor++];
        const campaign = byId.get(key(target.platform, target.id));

        if (!campaign) {
          // Not in our cache — refuse rather than guess. A campaign we've never
          // synced is one whose status we cannot check `canApply` against.
          results.push({
            campaignId: target.id,
            platform: target.platform,
            name: `#${target.id}`,
            ok: false,
            skipped: true,
            error: "Unknown campaign — not in the local cache. Run sync-entities.",
          });
          continue;
        }

        const { result, after } = await applyOne(eb, instantly, action, campaign);
        results.push(result);

        // Skipped attempts never reached EmailBison, so they are not history.
        if (!result.skipped) {
          auditRows.push({
            team_id: teamId,
            /*
             * `campaign_id` keeps meaning "an EmailBison campaign" and goes
             * NULL for Instantly — there is no EmailBison campaign to name, and
             * inventing one would corrupt every report that reads it. 083 added
             * platform + campaign_ref for the unambiguous pair.
             */
            campaign_id: campaign.platform === "emailbison" ? Number(campaign.id) : null,
            platform: campaign.platform,
            campaign_ref: campaign.id,
            campaign_name: campaign.name,
            action,
            actor,
            status: result.ok ? "ok" : "error",
            error: result.error ?? null,
            before_state: { status: campaign.status, total_leads: campaign.total_leads },
            after_state: result.ok ? { status: after ?? campaign.status } : null,
            batch_id: batchId,
          });
        }

        if (result.ok && after) {
          statusWrites.push({ platform: campaign.platform, id: campaign.id, status: after });
        }
      }
    }),
  );

  /*
   * Write the new status straight into the cache instead of waiting for
   * sync-entities. Without this the row snaps back to its old status on the
   * next refetch and reads as "the action didn't work" for up to 30 minutes.
   */
  await Promise.all([
    auditRows.length ? sb.from("campaign_audit_log").insert(auditRows) : Promise.resolve(),
    /*
     * Written back to the SOURCE table, not the view — a view over a union is
     * not updatable. Instantly stores its status as an integer, so the word is
     * translated back; writing "paused" into an integer column would fail the
     * insert and leave the UI showing a stale status after a successful action.
     */
    ...statusWrites.map((w) =>
      w.platform === "instantly"
        ? sb
            .from("instantly_campaigns")
            .update({ status: INSTANTLY_STATUS_CODE[w.status] ?? null })
            .eq("id", w.id)
        : sb.from("campaigns").update({ status: w.status }).eq("id", Number(w.id)),
    ),
  ]);

  // Stable order out, whatever order the pool finished in.
  const order = new Map(targets.map((t, i) => [key(t.platform, t.id), i]));
  results.sort(
    (a, b) =>
      (order.get(key(a.platform, a.campaignId)) ?? 0) -
      (order.get(key(b.platform, b.campaignId)) ?? 0),
  );

  return { batchId, results };
}
