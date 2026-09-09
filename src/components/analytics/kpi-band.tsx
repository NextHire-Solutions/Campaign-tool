"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { DASH, type Delta } from "@/lib/analytics/format.ts";
import { cn } from "@/lib/utils";

/*
 * The headline band: two rows of six, full-bleed, separated by hairlines.
 *
 * Deliberately NOT cards. Twelve bordered boxes with their own shadows read as
 * twelve separate things; the reference renders one continuous instrument
 * panel, and the hairline grid is what makes it scan as a single reading rather
 * than a dozen widgets.
 *
 * Values are `tabular-nums` (via .tnum) so digits sit in fixed columns and the
 * band doesn't shimmer as numbers refetch.
 */

export interface KpiCellData {
  key: string;
  label: string;
  /** Pre-formatted. Formatting decisions belong in format.ts, not here. */
  value: string;
  delta?: Delta | null;
  /** Shown as a tooltip-ish hint under the value, e.g. coverage caveats. */
  note?: string;
  /**
   * Whether an increase is good. Bounces going up is not a green number, and
   * that judgement belongs to the metric, not the formatter.
   */
  upIsGood?: boolean;
}

export const KPI_ROW_1 = [
  "sent",
  "prospects",
  "replies",
  "humanReplies",
  "positive",
  "bounces",
] as const;

export const KPI_ROW_2 = [
  "medianReplyTime",
  "medianFollowUpTime",
  "replyRate",
  "humanRate",
  "positiveRate",
  "leadToEmail",
] as const;

export const KPI_LABELS: Record<string, string> = {
  sent: "Sent",
  prospects: "Prospects",
  replies: "Replies",
  humanReplies: "Human Replies",
  positive: "Positive",
  bounces: "Bounces",
  medianReplyTime: "Median Reply Time",
  medianFollowUpTime: "Median Follow-up Time",
  replyRate: "Reply Rate",
  humanRate: "Human Rate",
  positiveRate: "Positive Rate",
  leadToEmail: "Lead to Email",
};

function KpiCell({
  cell,
  loading,
}: {
  cell: KpiCellData;
  loading?: boolean;
}) {
  const tone =
    cell.delta && cell.delta.tone !== "flat"
      ? (cell.delta.tone === "up") === (cell.upIsGood ?? true)
        ? "text-success"
        : "text-destructive"
      : "text-muted-foreground";

  return (
    <div className="min-w-0 px-4 py-3">
      <p className="truncate text-xs text-muted-foreground">{cell.label}</p>
      {loading ? (
        <Skeleton className="mt-1.5 h-7 w-24" />
      ) : (
        <div className="mt-0.5 flex items-baseline gap-2">
          <span className="tnum text-2xl font-semibold leading-tight">
            {cell.value}
          </span>
          {cell.delta ? (
            <span className={cn("tnum text-xs font-medium", tone)}>
              {cell.delta.label}
            </span>
          ) : null}
        </div>
      )}
      {cell.note && !loading ? (
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70">
          {cell.note}
        </p>
      ) : null}
    </div>
  );
}

export function KpiBand({
  cells,
  loading,
  scope,
}: {
  cells: KpiCellData[];
  loading?: boolean;
  /**
   * Which platforms these twelve figures describe, when it is not all of them.
   *
   * Undefined for the whole estate — a caption on every view would be noise,
   * and the one that matters is the narrowed case.
   */
  scope?: string;
}) {
  const byKey = new Map(cells.map((cell) => [cell.key, cell]));

  const render = (keys: readonly string[]) =>
    keys.map((key) => (
      <KpiCell
        key={key}
        loading={loading}
        cell={
          byKey.get(key) ?? {
            key,
            label: KPI_LABELS[key] ?? key,
            value: DASH,
          }
        }
      />
    ));

  return (
    <div className="shrink-0 border-b">
      <div className="grid grid-cols-2 divide-x divide-[--hairline] sm:grid-cols-3 lg:grid-cols-6">
        {render(KPI_ROW_1)}
      </div>
      <div className="grid grid-cols-2 divide-x divide-[--hairline] border-t border-[--hairline] sm:grid-cols-3 lg:grid-cols-6">
        {render(KPI_ROW_2)}
      </div>
      {scope ? (
        <p className="border-t border-[--hairline] px-4 py-1 text-[11px] text-muted-foreground">
          {scope}
        </p>
      ) : null}
    </div>
  );
}
