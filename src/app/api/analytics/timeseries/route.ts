import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase/server";
import { resolveFilters, toISODate } from "@/lib/analytics/query-params.ts";

export const dynamic = "force-dynamic";

interface Row {
  period: string;
  stat_date: string;
  sent: number;
  prospects: number;
  replies: number;
  human: number;
  positive: number;
  bounces: number;
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

  try {
    const { data, error } = await getSupabase().rpc("analytics_timeseries", {
      p_team_id: teamId,
      p_from: filters.from,
      p_to: filters.to,
      p_campaign_ids: filters.campaignIds.length ? filters.campaignIds : null,
      p_client_ids: filters.clientIds.length ? filters.clientIds : null,
      p_exclude_weekends: filters.excludeWeekends,
      p_compare: filters.compare,
    });
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as Row[];

    /*
     * The chart pairs the two periods BY INDEX, so both arrays have to be the
     * same length or the overlay silently drifts.
     *
     * They usually are — two windows of equal calendar length. But `Exclude
     * weekends` filters each window on its own, and 30 days starting on a
     * Tuesday holds 22 weekdays while the 30 before it hold 21. That left the
     * most recent day with no counterpart at all: the comparison line stopped
     * one point short of the line it was drawn against.
     *
     * Aligned from the TAIL, so the newest day — the one being read — always
     * has a partner, and any shortfall falls off the oldest edge where it is
     * both visible and harmless. `null` renders as a gap; the chart's `value()`
     * already returns null for a missing point.
     */
    const alignToTail = <T,>(series: T[], length: number): Array<T | null> =>
      series.length >= length
        ? series.slice(series.length - length)
        : [...Array<null>(length - series.length).fill(null), ...series];

    const shape = (r: Row) => ({
      date: r.stat_date,
      sent: Number(r.sent),
      prospects: Number(r.prospects),
      replies: Number(r.replies),
      human: Number(r.human),
      positive: Number(r.positive),
      bounces: Number(r.bounces),
    });

    let points = rows.filter((r) => r.period === "current").map(shape);

    /*
     * INSTANTLY, added day by day when the platform filter asks for it.
     *
     * Merged into the SAME points rather than drawn as extra series: the chart's
     * lines are metrics (Sent, Replies, …), not platforms, and adding
     * "Sent (Instantly)" would double the legend and make the two impossible to
     * read against each other. A day the two platforms share becomes one point
     * whose Sent is the sum, which is what "Sent" means once both are in scope.
     *
     * POSITIVE IS LEFT AS THE EMAILBISON FIGURE and the KPI band above already
     * dashes it in this mode — MasterInbox owns Positive and has no labels for
     * Instantly, so there is nothing to add. It is not summed, so it cannot
     * silently claim to cover both.
     */
    const wantsInstantly = filters.platforms.includes("instantly");
    const wantsEmailBison =
      filters.platforms.length === 0 || filters.platforms.includes("emailbison");

    if (wantsInstantly) {
      const { data: inst, error: instError } = await getSupabase().rpc(
        "analytics_instantly_timeseries",
        {
          p_team_id: teamId,
          p_from: filters.from,
          p_to: filters.to,
          p_client_ids: filters.clientIds.length ? filters.clientIds : null,
          p_campaign_ids: null,
        },
      );
      if (instError) throw new Error(instError.message);

      const byDay = new Map(points.map((p) => [p.date, p]));
      if (!wantsEmailBison) {
        // Instantly alone: every EmailBison point must go, or the chart would
        // show one platform's line labelled as the other's.
        for (const p of byDay.values()) {
          p.sent = 0; p.prospects = 0; p.replies = 0; p.human = 0; p.bounces = 0;
        }
      }

      for (const r of (inst ?? []) as Array<Record<string, unknown>>) {
        const day = String(r.day);
        const existing = byDay.get(day);
        const add = {
          sent: Number(r.sent ?? 0),
          prospects: Number(r.prospects ?? 0),
          replies: Number(r.replies ?? 0),
          human: Number(r.human_replies ?? 0),
        };
        if (existing) {
          existing.sent += add.sent;
          existing.prospects += add.prospects;
          existing.replies += add.replies;
          existing.human += add.human;
        } else {
          // A day Instantly sent on and EmailBison did not. Positive stays 0
          // rather than null because this shape is numeric throughout; the band
          // is where the coverage caveat lives.
          byDay.set(day, {
            date: day,
            sent: add.sent,
            prospects: add.prospects,
            replies: add.replies,
            human: add.human,
            positive: 0,
            bounces: 0,
          });
        }
      }
      points = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
    }

    return NextResponse.json({
      points,
      // The comparison series is returned separately rather than merged: the
      // two periods have different dates, and zipping them by index here keeps
      // that fiction out of the chart component.
      compare: filters.compare
        ? alignToTail(rows.filter((r) => r.period === "previous").map(shape), points.length)
        : undefined,
      compareLabel:
        filters.compare && filters.compareFrom
          ? { from: filters.compareFrom, to: filters.compareTo }
          : undefined,
      mode: filters.mode,
    });
  } catch (error) {
    console.error("[api/analytics/timeseries]", error);
    return NextResponse.json({ error: "Failed to load chart data" }, { status: 500 });
  }
}
