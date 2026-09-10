"use client";

import { useQuery } from "@tanstack/react-query";
import { useAnalyticsFilters } from "./filters-context";
import {
  compactNumber,
  delta,
  duration,
  percent,
  ratio,
  type Delta,
} from "@/lib/analytics/format.ts";
import type { KpiCellData } from "./kpi-band";

/*
 * Fetches the KPI band and maps it to display cells.
 *
 * Formatting happens HERE, through format.ts, rather than on the server — so
 * the KPI band and the tables share one set of rules and `DASH` stays the only
 * way a nullish metric reaches the DOM.
 */

interface KpiValues {
  sent: number;
  prospects: number;
  replies: number;
  humanReplies: number;
  positive: number;
  bounces: number;
  medianReplyTime: number | null;
  medianFollowUpTime: number | null;
  replyRate: number | null;
  humanRate: number | null;
  positiveRate: number | null;
  leadToEmail: number | null;
}

interface KpiResponse {
  current: KpiValues;
  previous?: KpiValues;
  deltas?: Partial<Record<keyof KpiValues, number | null>>;
  coverage: {
    followUpBusinessHours: string | null;
    followUpSampleSize: number | null;
    replyTimingSampleSize: number;
    /**
     * Which platforms the figures above actually describe.
     *
     * The route has always sent this; nothing read it, so the band showed a
     * scope it never named. That was survivable while the platform filter was
     * unreachable from this tab and the answer was always EmailBison — it stops
     * being survivable now that it can be changed.
     */
    platforms?: string[];
    /** False when Positive omits Instantly — which is why it reads as a dash. */
    positiveCoversInstantly?: boolean;
    /** Set when a campaign filter took Instantly out of scope. */
    instantlyExcludedBy?: "campaign-filter" | null;
  };
}

const PLATFORM_LABEL: Record<string, string> = {
  emailbison: "EmailBison",
  instantly: "Instantly",
};

function scopeNote(platforms: string[] | undefined): string | undefined {
  // One platform is the case worth calling out. Both, or unknown, is the
  // whole estate and needs no caveat.
  if (!platforms || platforms.length !== 1) return undefined;
  return `${PLATFORM_LABEL[platforms[0]] ?? platforms[0]} only`;
}

/**
 * Whether a rise is good news. Bounces going up is not a green number, and that
 * judgement belongs to the metric, not the formatter.
 */
const UP_IS_GOOD: Record<string, boolean> = {
  sent: true,
  prospects: true,
  replies: true,
  humanReplies: true,
  positive: true,
  bounces: false,
  medianReplyTime: false, // faster is better
  medianFollowUpTime: false,
  replyRate: true,
  humanRate: true,
  positiveRate: true,
  leadToEmail: false, // fewer emails per positive is better
};

export function useKpis() {
  const { toQueryString } = useAnalyticsFilters();
  const qs = toQueryString();

  const query = useQuery<KpiResponse>({
    queryKey: ["kpis", qs],
    queryFn: async () => {
      const response = await fetch(`/api/analytics/kpis${qs ? `?${qs}` : ""}`);
      if (!response.ok) throw new Error("Failed to load metrics");
      return response.json();
    },
  });

  const data = query.data;
  const deltaFor = (key: keyof KpiValues): Delta | null =>
    data?.deltas ? delta(data.deltas[key] ?? null) : null;

  const cell = (
    key: keyof KpiValues,
    label: string,
    value: string,
    note?: string,
  ): KpiCellData => ({
    key,
    label,
    value,
    delta: deltaFor(key),
    note,
    upIsGood: UP_IS_GOOD[key] ?? true,
  });

  const c = data?.current;

  /*
   * When a campaign filter has taken Instantly out of scope, SAY THAT instead
   * of the bare platform name. "EmailBison only" beside a ticked Instantly chip
   * invites the reader to conclude the filter is broken.
   */
  const scope =
    data?.coverage.instantlyExcludedBy === "campaign-filter"
      ? "EmailBison only — the campaign filter selects EmailBison campaigns, so Instantly is not included"
      : scopeNote(data?.coverage.platforms);

  /*
   * Why Positive is a dash, said on the tile rather than left to be discovered.
   *
   * Positive is decided by MasterInbox labels, which key on EmailBison reply
   * ids — no Instantly reply has one. So with Instantly in scope the honest
   * answer is "not available", and rule 1 renders that as DASH. An unexplained
   * dash beside eleven populated tiles reads as a broken metric; this names it
   * as a coverage limit, which is what it is.
   */
  const positiveNote =
    data && data.coverage.positiveCoversInstantly === false
      ? "EmailBison only"
      : scope;

  const cells: KpiCellData[] = c
    ? [
        cell("sent", "Sent", compactNumber(c.sent)),
        cell("prospects", "Prospects", compactNumber(c.prospects)),
        cell("replies", "Replies", compactNumber(c.replies)),
        cell("humanReplies", "Human Replies", compactNumber(c.humanReplies)),
        cell("positive", "Positive", compactNumber(c.positive), positiveNote),
        cell("bounces", "Bounces", compactNumber(c.bounces)),
        cell(
          "medianReplyTime",
          "Median Reply Time",
          duration(c.medianReplyTime),
          data?.coverage.replyTimingSampleSize
            ? `n=${data.coverage.replyTimingSampleSize}`
            : "no timing data yet",
        ),
        cell(
          "medianFollowUpTime",
          "Median Follow-up Time",
          duration(c.medianFollowUpTime),
          // Surfaced because this metric is business-hours adjusted while
          // Median Reply Time is raw elapsed time. Side by side they would
          // otherwise read as the same kind of measure.
          data?.coverage.followUpBusinessHours ? "business hours" : undefined,
        ),
        cell("replyRate", "Reply Rate", percent(c.replyRate)),
        cell("humanRate", "Human Rate", percent(c.humanRate)),
        cell("positiveRate", "Positive Rate", percent(c.positiveRate), positiveNote),
        cell("leadToEmail", "Lead to Email", ratio(c.leadToEmail), positiveNote),
      ]
    : [];

  /*
   * The band-wide scope is returned ONCE, not stamped onto twelve tiles.
   * "EmailBison only" repeated a dozen times is noise that trains the eye to
   * skip exactly the caveat it is there to deliver; the per-tile note stays for
   * the metrics whose coverage differs from the band's.
   */
  return { cells, scope, isLoading: query.isLoading, error: query.error };
}
