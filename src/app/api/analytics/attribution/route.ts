import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase/server";
import { resolveFilters, toISODate } from "@/lib/analytics/query-params.ts";
import { CONVERSION_MEASURES, STAGE_ORDER } from "@/lib/analytics/outcomes.ts";

export const dynamic = "force-dynamic";

/*
 * The Attribution tab (spec §7).
 *
 * Four questions in one payload, because they are read together and a partial
 * answer to any of them is misleading on its own:
 *
 *   coverage  — how much of the feed is credited to a campaign at all. This
 *               number gates the others; 44% attributed and 100% attributed
 *               support completely different conclusions from the same table.
 *   totals    — every event type in the range, whether or not it was attributed.
 *   measures  — "how many emails it takes to earn one introduction" (§7).
 *   campaigns — which campaigns produce RESULTS, not just activity.
 *
 * `sent` for the conversion measures comes from the same eb_daily_series the KPI
 * band's Sent tile reads, so "Email to Introduction" and "Sent" can never
 * disagree about the numerator.
 */

interface TotalRow {
  event_type: string;
  events: number;
  people: number;
  attributed: number;
  unattributed: number;
}

interface CampaignRow {
  campaign_id: number;
  campaign_name: string | null;
  client_name: string | null;
  sent: number;
  outcomes: number;
  people: number;
  by_type: Record<string, number> | null;
}

interface CoverageRow {
  total: number;
  attributed: number;
  other_platform: number;
  unattributed: number;
  pending: number;
  by_method: Record<string, number> | null;
  by_platform: Record<string, number> | null;
}

export async function GET(request: NextRequest) {
  const teamId = Number(process.env.EMAILBISON_TEAM_ID || 2);

  let filters;
  try {
    filters = resolveFilters(request.nextUrl.searchParams, toISODate(new Date()));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid filters" },
      { status: 400 },
    );
  }

  const clientIds = filters.clientIds.length ? filters.clientIds : null;
  const campaignIds = filters.emailbisonCampaignIds.length ? filters.emailbisonCampaignIds : null;
  const sb = getSupabase();

  try {
    const [totals, campaigns, coverage, sent, timeline] = await Promise.all([
      sb.rpc("analytics_outcome_totals", {
        p_team_id: teamId,
        p_from: filters.from,
        p_to: filters.to,
        p_client_ids: clientIds,
        p_campaign_ids: campaignIds,
        // The only endpoint where this is real: outcomes are the sole data with
        // more than one platform behind them.
        p_platforms: filters.platforms.length ? filters.platforms : null,
      }),
      sb.rpc("analytics_outcome_campaigns", {
        p_team_id: teamId,
        p_from: filters.from,
        p_to: filters.to,
        p_client_ids: clientIds,
        // Instantly outcomes are credited to no campaign, so selecting it
        // correctly empties this table instead of ignoring the filter.
        p_platforms: filters.platforms.length ? filters.platforms : null,
      }),
      sb.rpc("analytics_outcome_coverage", {
        p_team_id: teamId,
        p_from: filters.from,
        p_to: filters.to,
      }),
      sb.rpc("analytics_kpis", {
        p_team_id: teamId,
        p_from: filters.from,
        p_to: filters.to,
        p_client_ids: clientIds,
        p_campaign_ids: campaignIds,
        p_compare: false,
      }),
      // §7: "so the funnel can be read as a timeline, not just a set of totals".
      sb.rpc("analytics_outcome_timeline", {
        p_team_id: teamId,
        p_from: filters.from,
        p_to: filters.to,
        p_client_ids: clientIds,
        p_campaign_ids: campaignIds,
        p_platforms: filters.platforms.length ? filters.platforms : null,
      }),
    ]);

    for (const r of [totals, campaigns, coverage, sent, timeline]) {
      if (r.error) throw new Error(r.error.message);
    }

    const totalRows = ((totals.data ?? []) as TotalRow[]).map((r) => ({
      type: r.event_type,
      events: Number(r.events),
      people: Number(r.people),
      attributed: Number(r.attributed),
      unattributed: Number(r.unattributed),
    }));

    const byType = new Map(totalRows.map((r) => [r.type, r.events]));
    const emailsSent = Number(
      (sent.data as Array<{ sent?: number }> | null)?.[0]?.sent ?? 0,
    );

    /*
     * A measure with no outcomes yet returns null, not Infinity and not 0.
     * "3 emails per hire" and "no hires yet" must never render the same way —
     * `DASH` is the only way a nullish metric reaches the DOM (CLAUDE.md rule 1).
     */
    const measures = CONVERSION_MEASURES.map((m) => {
      const count = m.types.reduce((t, type) => t + (byType.get(type) ?? 0), 0);
      return {
        key: m.key,
        label: m.label,
        count,
        emailsPer: count > 0 && emailsSent > 0 ? emailsSent / count : null,
      };
    });

    // The funnel, in progression order, with types the feed has not sent in this
    // range still present at 0 — a missing stage would read as a gap in the
    // pipeline rather than a stage nobody reached.
    const funnel = STAGE_ORDER.map((type) => {
      const row = totalRows.find((r) => r.type === type);
      return {
        type,
        events: row?.events ?? 0,
        people: row?.people ?? 0,
      };
    });

    const cov = ((coverage.data ?? []) as CoverageRow[])[0];

    return NextResponse.json({
      range: { from: filters.from, to: filters.to },
      platforms: filters.platforms,
      emailsSent,
      measures,
      funnel,
      totals: totalRows,
      coverage: cov
        ? {
            total: Number(cov.total),
            attributed: Number(cov.attributed),
            otherPlatform: Number(cov.other_platform),
            unattributed: Number(cov.unattributed),
            pending: Number(cov.pending),
            byMethod: cov.by_method ?? {},
            byPlatform: cov.by_platform ?? {},
          }
        : null,
      /*
       * Weekly buckets, pivoted to one row per week with a column per type.
       * Weeks rather than days because outcomes are rare — 1,630 across 90 days
       * and nine types — so a daily series is mostly zeroes with single-event
       * spikes that read as noise rather than as a trend.
       */
      timeline: (() => {
        const byWeek = new Map<string, Record<string, number>>();
        for (const row of (timeline.data ?? []) as Array<{
          week: string;
          event_type: string;
          events: number;
        }>) {
          const bucket = byWeek.get(row.week) ?? {};
          bucket[row.event_type] = Number(row.events);
          byWeek.set(row.week, bucket);
        }
        return [...byWeek.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([week, counts]) => ({
            week,
            counts,
            total: Object.values(counts).reduce((sum, n) => sum + n, 0),
          }));
      })(),
      campaigns: ((campaigns.data ?? []) as CampaignRow[]).map((r) => ({
        campaignId: Number(r.campaign_id),
        name: r.campaign_name,
        client: r.client_name,
        sent: Number(r.sent),
        outcomes: Number(r.outcomes),
        people: Number(r.people),
        byType: r.by_type ?? {},
      })),
    });
  } catch (error) {
    console.error("[api/analytics/attribution]", error);
    return NextResponse.json({ error: "Failed to load attribution" }, { status: 500 });
  }
}
