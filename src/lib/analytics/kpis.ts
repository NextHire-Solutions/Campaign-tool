import { getSupabase } from "@/lib/supabase/server";
import {
  bounceRate,
  humanRate,
  leadToEmail,
  periodDelta,
  positiveRate,
  replyRate,
} from "./metrics.ts";
import type { ResolvedFilters } from "./query-params.ts";
import { resolvePlatformScope } from "./platform-scope.ts";
import { fetchFollowUpOverall } from "./follow-up.ts";

/*
 * Assembles the KPI band from three sources, because no single one has all of it:
 *
 *   analytics_kpis          the six counts (Sent, Prospects, Replies, Human,
 *                           Positive, Bounces), both periods in one call
 *   analytics_reply_timing  Median Reply Time, from replies with a resolved
 *                           first-send timestamp
 *   portal follow-up API    Median Follow-up Time — a business-hours-adjusted
 *                           median computed upstream
 *
 * Rates are derived here from the counts rather than computed in SQL, so the
 * formulas live in metrics.ts once and the RPC only has to return integers.
 */

export interface KpiValues {
  sent: number;
  prospects: number;
  replies: number;
  humanReplies: number;
  /*
   * Nullable: Instantly can supply neither, and a 0 would read as "none" when
   * it means "not available for the platforms in scope". Every formatter in
   * format.ts already renders null as a dash.
   */
  positive: number | null;
  bounces: number | null;
  medianReplyTime: number | null;
  medianFollowUpTime: number | null;
  replyRate: number | null;
  humanRate: number | null;
  positiveRate: number | null;
  leadToEmail: number | null;
  bounceRate: number | null;
}

export interface KpiResponse {
  current: KpiValues;
  previous?: KpiValues;
  deltas?: Partial<Record<keyof KpiValues, number | null>>;
  compareLabel?: { from: string; to: string };
  coverage: {
    /** Median Follow-up Time is business-hours adjusted; Reply Time is not. */
    followUpBusinessHours: string | null;
    followUpSampleSize: number | null;
    replyTimingSampleSize: number;
    /** Which sending platforms the figures above actually describe. */
    platforms?: string[];
    /** False while MasterInbox labels do not reach Instantly replies. */
    positiveCoversInstantly?: boolean;
    /**
     * Why Instantly was left out despite being selected. Null when it wasn't.
     *
     * The band needs to SAY this: an EmailBison-only figure with the Instantly
     * chip visibly ticked looks like the filter is being ignored — which is
     * precisely what the old behaviour did, in the other direction.
     */
    instantlyExcludedBy?: "campaign-filter" | null;
  };
}

interface RpcRow {
  period: string;
  sent: number;
  prospects: number;
  replies: number;
  human_replies: number;
  /*
   * Nullable because Instantly cannot supply either. MasterInbox labels decide
   * Positive and key on EmailBison reply ids; Instantly publishes no per-day
   * bounce figure. When Instantly is in scope both go null and reach the DOM
   * as a dash, rather than a partial figure that would misstate the rates.
   */
  positive: number | null;
  bounces: number | null;
}

function derive(
  row: RpcRow | undefined,
  prospects: number | null,
  medianReply: number | null,
  medianFollowUp: number | null,
): KpiValues {
  const sent = Number(row?.sent ?? 0);
  const replies = Number(row?.replies ?? 0);
  const humanReplies = Number(row?.human_replies ?? 0);
  /*
   * NULL SURVIVES. `?? 0` would turn "we do not have this" into "there were
   * none" — and these two are exactly the metrics Instantly cannot supply:
   * MasterInbox owns Positive and keys on EmailBison reply ids, and Instantly
   * publishes no per-day bounce figure at all. A 0 next to 884 replies reads as
   * a collapse in performance rather than a gap in coverage, which is the
   * confusion rule 1 exists to prevent. The formatters render null as a dash.
   */
  const positive = row?.positive == null ? null : Number(row.positive);
  const bounces = row?.bounces == null ? null : Number(row.bounces);

  return {
    sent,
    // NOT row.prospects -- that column sums daily distinct counts and
    // overcounts. See fetchProspects().
    prospects: prospects ?? 0,
    replies,
    humanReplies,
    positive,
    bounces,
    medianReplyTime: medianReply,
    medianFollowUpTime: medianFollowUp,
    replyRate: replyRate(replies, sent),
    humanRate: humanRate(humanReplies, sent),
    // A rate whose numerator is unknown is unknown, not zero. Dividing null by
    // a real reply count would print 0.0% and read as "nothing converted".
    positiveRate: positive == null ? null : positiveRate(positive, replies),
    leadToEmail: positive == null ? null : leadToEmail(sent, positive),
    bounceRate: bounces == null ? null : bounceRate(bounces, sent),
  };
}

/**
 * Prospects = DISTINCT leads contacted in the range.
 *
 * This CANNOT be a sum of the daily values. `total_leads_contacted` is itself a
 * distinct count per day, so a lead emailed on eight days contributes eight
 * times. Over 62 days that inflated Prospects to ~= Sent, which is nonsense.
 *
 * EmailBison computes the distinct count correctly for any range, so ask it
 * once. Unfiltered that is a single workspace call; filtered it is one call per
 * selected campaign, which is why the campaign picker should stay narrow.
 *
 * Note the residual caveat when filtering: per-campaign distinct counts still
 * double-count a lead that appears in two selected campaigns. EmailBison
 * exposes no cross-campaign distinct count, so that is a genuine upstream
 * limit, not something to paper over.
 */
/*
 * How long a live upstream answer may be reused.
 *
 * Prospects and Median Follow-up are the only two KPI values fetched live, and
 * they sit in the same Promise.all as the Supabase RPCs — so the band waits for
 * whichever is slowest, measured at 250-400ms warm, on EVERY filter change.
 * The same (from, to, campaignIds) always yields the same answer, so paying
 * that on a re-render is pure latency.
 *
 * Five minutes is deliberately shorter than the 10-minute reply sync that feeds
 * the tiles beside them: the band can never show a Prospects figure staler than
 * the counts it sits next to.
 */
const UPSTREAM_TTL_SECONDS = 300;

async function fetchProspects(
  from: string,
  to: string,
  campaignIds: number[],
): Promise<number | null> {
  const base = process.env.EMAILBISON_BASE_URL;
  const key = process.env.EMAILBISON_API_KEY;
  if (!base || !key) return null;

  const headers = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  try {
    if (campaignIds.length === 0) {
      const response = await fetch(
        `${base}/api/workspaces/v1.1/stats?start_date=${from}&end_date=${to}`,
        { headers, next: { revalidate: UPSTREAM_TTL_SECONDS } },
      );
      if (!response.ok) return null;
      const body = await response.json();
      return Number(body?.data?.total_leads_contacted ?? 0);
    }

    // Cap the fan-out: beyond this the latency is worse than the precision is
    // worth, and the caller is better served by a narrower filter.
    const targets = campaignIds.slice(0, 25);
    const results = await Promise.all(
      targets.map(async (id) => {
        const response = await fetch(`${base}/api/campaigns/${id}/stats`, {
          method: "POST",
          headers,
          body: JSON.stringify({ start_date: from, end_date: to }),
          // A POST is not cached by Next, so the fan-out branch still pays full
          // latency. It is capped at 25 campaigns and only runs when the user
          // has actually picked campaigns; the common unfiltered path above is
          // the one that had to be fast.
          cache: "no-store",
        });
        if (!response.ok) return 0;
        const body = await response.json();
        return Number(body?.data?.total_leads_contacted ?? 0);
      }),
    );
    return results.reduce((total, n) => total + n, 0);
  } catch {
    return null;
  }
}

/*
 * Median Follow-up Time moved to ./follow-up.ts when the portal gained a
 * per-campaign breakdown — the Campaigns table needs the same upstream, and two
 * copies of a fetch would eventually disagree about the TTL or the
 * content-type guard.
 */

export async function loadKpis(
  filters: ResolvedFilters,
  teamId: number,
): Promise<KpiResponse> {
  const sb = getSupabase();

  const args = {
    p_team_id: teamId,
    p_from: filters.from,
    p_to: filters.to,
    p_campaign_ids: filters.campaignIds.length ? filters.campaignIds : null,
    p_client_ids: filters.clientIds.length ? filters.clientIds : null,
  };

  const [counts, timing, followUp, prospects, previousTiming, previousFollowUp, previousProspects] =
    await Promise.all([
      sb.rpc("analytics_kpis", { ...args, p_compare: filters.compare }),
      sb.rpc("analytics_reply_timing", args),
      fetchFollowUpOverall(filters.from, filters.to),
      fetchProspects(filters.from, filters.to, filters.campaignIds),
      filters.compare && filters.compareFrom && filters.compareTo
        ? sb.rpc("analytics_reply_timing", {
            ...args,
            p_from: filters.compareFrom,
            p_to: filters.compareTo,
          })
        : Promise.resolve(null),
      filters.compare && filters.compareFrom && filters.compareTo
        ? fetchFollowUpOverall(filters.compareFrom, filters.compareTo)
        : Promise.resolve(null),
      filters.compare && filters.compareFrom && filters.compareTo
        ? fetchProspects(filters.compareFrom, filters.compareTo, filters.campaignIds)
        : Promise.resolve(null),
    ]);

  if (counts.error) throw new Error(`analytics_kpis: ${counts.error.message}`);

  const rows = (counts.data ?? []) as RpcRow[];
  let currentRow = rows.find((r) => r.period === "current");
  const previousRow = rows.find((r) => r.period === "previous");

  /*
   * `currentRow` IS THE EMAILBISON ROW, and it is computed whether or not
   * EmailBison is in scope — the RPC above runs unconditionally.
   *
   * That was survivable only because the one path that excluded EmailBison
   * (Instantly alone) always rebuilt the row from Instantly's figures. Once a
   * campaign filter could take Instantly out of scope too, "Instantly only,
   * campaign selected" left EmailBison's own numbers standing under an
   * "Instantly only" label — the same leak as before with the platforms
   * swapped. Zeroing it here means the row is never a platform nobody asked
   * for, regardless of which branch runs below.
   */

  /*
   * INSTANTLY, WHEN THE PLATFORM FILTER ASKS FOR IT.
   *
   * Instantly is the larger half of the sending — 840,416 sends against
   * EmailBison's ~435,000 — so a band that ignores it describes under a third
   * of the operation. But the two platforms do not answer the same questions,
   * and pretending otherwise breaks rule 3:
   *
   *   Sent / Prospects / Replies / Human / BOUNCES   both platforms report
   *                                        these and they add up. Bounces
   *                                        joined that list in 077, once the
   *                                        per-day figures were found on the
   *                                        ranged analytics endpoint.
   *   POSITIVE                             MasterInbox labels decide it, and
   *                                        they key on EmailBison reply ids.
   *                                        No Instantly reply has one, and no
   *                                        amount of Instantly syncing changes
   *                                        that — it is a gap in what has been
   *                                        LABELLED, not in what was fetched.
   *
   * Adding Instantly's replies to the numerator-less Positive would halve the
   * Positive RATE overnight and read as a collapse in performance rather than a
   * change in what is being counted. So Positive alone goes NULL — a dash —
   * whenever Instantly is in scope, and `coverage` says which platforms the
   * row actually describes.
   */
  /*
   * A CAMPAIGN FILTER TAKES INSTANTLY OUT OF SCOPE. Campaign ids are
   * EmailBison integers, so the selection contains no Instantly campaign and
   * Instantly's honest contribution is nothing. Passing `p_campaign_ids: null`
   * meant "no restriction" and added the entire Instantly workspace to whatever
   * single campaign was selected — 43,283 sent on a campaign that sent 2.
   */
  const scope = resolvePlatformScope({
    platforms: filters.platforms,
    campaignIds: filters.campaignIds,
  });
  const wantsInstantly = scope.instantly;
  const wantsEmailBison = scope.emailbison;

  if (!wantsEmailBison && currentRow) {
    currentRow = {
      ...currentRow,
      sent: 0,
      prospects: 0,
      replies: 0,
      human_replies: 0,
      positive: 0,
      bounces: 0,
    };
  }

  let platformsCovered: string[] = wantsEmailBison ? ["emailbison"] : [];

  if (wantsInstantly) {
    const { data: inst, error: instError } = await sb.rpc("analytics_instantly_kpis", {
      p_team_id: teamId,
      p_from: filters.from,
      p_to: filters.to,
      // Instantly campaigns are UUID-keyed, so an EmailBison campaign filter
      // cannot apply to them; a client filter can, and does.
      p_client_ids: filters.clientIds.length ? filters.clientIds : null,
      p_campaign_ids: null,
    });
    if (instError) throw new Error(`analytics_instantly_kpis: ${instError.message}`);

    const i = (inst ?? [])[0] as
      | {
          sent: number;
          prospects: number;
          replies: number;
          human_replies: number;
          bounces: number | null;
        }
      | undefined;

    if (i) {
      platformsCovered = [...platformsCovered, "instantly"];
      const base = wantsEmailBison ? currentRow : undefined;
      currentRow = {
        period: "current",
        sent: Number(base?.sent ?? 0) + Number(i.sent ?? 0),
        prospects: Number(base?.prospects ?? 0) + Number(i.prospects ?? 0),
        replies: Number(base?.replies ?? 0) + Number(i.replies ?? 0),
        human_replies: Number(base?.human_replies ?? 0) + Number(i.human_replies ?? 0),
        // Deliberately unavailable while Instantly is in scope. See above.
        positive: null,
        /*
         * Summed where BOTH sides have a figure. If Instantly's is null — a
         * window entirely before 077 wrote per-day bounces — the total goes
         * null too rather than silently reporting the EmailBison half as though
         * it were the whole.
         */
        bounces:
          i.bounces == null
            ? null
            : Number(base?.bounces ?? 0) + Number(i.bounces),
      } satisfies RpcRow;
    }
  }

  const medianReply = timing.data?.[0]?.median_reply_seconds ?? null;
  const replySamples = Number(timing.data?.[0]?.sample_size ?? 0);

  const current = derive(
    currentRow,
    prospects,
    medianReply === null ? null : Number(medianReply),
    followUp.seconds,
  );

  const response: KpiResponse = {
    current,
    coverage: {
      followUpBusinessHours: followUp.businessHours,
      followUpSampleSize: followUp.sampleSize,
      replyTimingSampleSize: replySamples,
      /*
       * Which platforms this row actually describes, so the band can say so
       * rather than leaving a reader to assume it covers everything.
       */
      platforms: platformsCovered,
      positiveCoversInstantly: false,
      /*
       * Instantly was asked for and deliberately left out. Surfaced so the band
       * can say so — an unexplained EmailBison-only figure while the Instantly
       * chip is visibly selected reads as the filter being ignored, which is
       * exactly what the previous behaviour actually was.
       */
      instantlyExcludedBy: scope.instantlyExcludedBy ?? null,
    },
  };

  if (filters.compare && previousRow) {
    const previousMedian = previousTiming?.data?.[0]?.median_reply_seconds ?? null;
    const previous = derive(
      previousRow,
      previousProspects,
      previousMedian === null ? null : Number(previousMedian),
      previousFollowUp?.seconds ?? null,
    );

    response.previous = previous;
    response.compareLabel = {
      from: filters.compareFrom!,
      to: filters.compareTo!,
    };
    response.deltas = Object.fromEntries(
      (Object.keys(current) as Array<keyof KpiValues>).map((key) => [
        key,
        periodDelta(current[key], previous[key]),
      ]),
    ) as KpiResponse["deltas"];
  }

  return response;
}
