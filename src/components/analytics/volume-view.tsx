"use client";

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useAnalyticsFilters } from "@/components/analytics/filters-context";
import { compactNumber, fullNumber, percent } from "@/lib/analytics/format.ts";
import { cn } from "@/lib/utils";

/*
 * Email volume: how much the estate can send, and where what it sent went.
 *
 * TWO SHAPES, BECAUSE THEY ARE TWO QUESTIONS.
 *
 * Capacity is one number and a ratio, so it is a stat tile — a chart of a
 * single value is decoration. The split is magnitude across ~40 named clients,
 * so it is a RANKED BAR and not the pie the request suggested: forty slices
 * cannot be compared by angle, the tail becomes unlabelled slivers, and the
 * one thing a reader wants — who is biggest, by how much — is exactly what a
 * pie makes hardest. Same data, legible.
 *
 * ONE MEASURE, ONE HUE. This is Sent, so it wears the Sent series colour rather
 * than a per-client palette: colour here would encode rank, which moves as the
 * date range moves, and colour must follow the entity or nothing (series.ts).
 * Every bar is labelled and carries its number, so nothing depends on colour.
 */

const SENT = "var(--series-sent)";

interface CapacityRow {
  platform: string;
  inboxes: number;
  daily_capacity: number;
  unavailable: number;
}
interface SplitRow {
  label: string;
  platform: string;
  sent: number;
  grand_total: number;
}
interface Response {
  capacity: CapacityRow[];
  rows: SplitRow[];
  total: number;
  days: number;
  group: "client" | "campaign";
}

const PLATFORM_LABEL: Record<string, string> = {
  emailbison: "EmailBison",
  instantly: "Instantly",
};

export function VolumeView() {
  const { toQueryString } = useAnalyticsFilters();
  const [group, setGroup] = useState<"client" | "campaign">("client");

  const { data, isFetching } = useQuery<Response>({
    queryKey: ["volume", toQueryString(), group],
    queryFn: async () => {
      const response = await fetch(`/api/analytics/volume?${toQueryString()}&group=${group}`);
      if (!response.ok) throw new Error("Could not load volume");
      return response.json();
    },
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const capacity = data?.capacity ?? [];
  const totalCapacity = capacity.reduce((n, c) => n + Number(c.daily_capacity), 0);
  const unavailable = capacity.reduce((n, c) => n + Number(c.unavailable), 0);
  const days = data?.days ?? 1;
  // Per day, because capacity is a daily figure. Comparing a 30-day total
  // against a daily ceiling would read as 750% utilisation.
  const sentPerDay = data ? Math.round(data.total / Math.max(days, 1)) : 0;
  const utilisation = totalCapacity > 0 ? sentPerDay / totalCapacity : null;

  const rows = data?.rows ?? [];
  const top = rows.length ? Math.max(...rows.map((r) => Number(r.sent))) : 0;

  return (
    <div className="space-y-5">
      {/* ---- Capacity: a stat tile, not a chart ---- */}
      <div className="rounded-xl border bg-card p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div>
            <p className="text-sm text-muted-foreground">Daily sending capacity</p>
            <p className="tnum mt-1 text-5xl font-semibold tracking-tight">
              {compactNumber(totalCapacity)}
            </p>
            <p className="tnum mt-2 text-sm text-muted-foreground">
              across {fullNumber(capacity.reduce((n, c) => n + Number(c.inboxes), 0))} inboxes
              {unavailable > 0 ? (
                <>
                  {" · "}
                  <span className="text-[#b02525]">
                    {fullNumber(unavailable)}/day in inboxes that cannot connect
                  </span>
                </>
              ) : null}
            </p>
          </div>

          <div className="min-w-[220px]">
            <p className="text-sm text-muted-foreground">Using</p>
            <p className="tnum mt-1 text-3xl font-semibold tracking-tight">
              {utilisation === null ? "–" : percent(utilisation, 0)}
            </p>
            <p className="tnum mt-1 text-xs text-muted-foreground">
              {fullNumber(sentPerDay)} sent a day over {fullNumber(days)} days
            </p>
            {/* The meter is the ratio the two numbers above already state; it
                exists so the gap is visible at a glance, not to add a fact. */}
            <span className="mt-2 block h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
              <span
                className="block h-full rounded-full"
                style={{
                  width: `${Math.min(utilisation ?? 0, 1) * 100}%`,
                  backgroundColor: SENT,
                }}
              />
            </span>
          </div>

          <div className="space-y-1">
            {capacity.map((c) => (
              <p key={c.platform} className="tnum text-xs text-muted-foreground">
                <span className="text-foreground">{PLATFORM_LABEL[c.platform] ?? c.platform}</span>{" "}
                {fullNumber(c.daily_capacity)}/day · {fullNumber(c.inboxes)} inboxes
              </p>
            ))}
          </div>
        </div>
      </div>

      {/* ---- The split ---- */}
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
          <div>
            <h2 className="text-sm font-medium">
              Where the volume went
              {isFetching ? (
                <Loader2 className="ml-2 inline size-3 animate-spin text-muted-foreground" />
              ) : null}
            </h2>
            <p className="tnum mt-0.5 text-xs text-muted-foreground">
              {fullNumber(data?.total)} sent in range · both platforms
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5">
            {(["client", "campaign"] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setGroup(key)}
                className={cn(
                  "rounded-md px-3 py-1 text-sm capitalize transition-colors",
                  group === key
                    ? "bg-background font-medium text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                By {key}
              </button>
            ))}
          </div>
        </div>

        {!rows.length ? (
          <p className="px-5 py-12 text-center text-sm text-muted-foreground">
            Nothing sent in this range.
          </p>
        ) : (
          <div className="space-y-1 p-4">
            {rows.map((row) => (
              <div
                key={`${row.label}-${row.platform}`}
                className="flex items-center gap-2 rounded px-1 py-0.5"
              >
                <span
                  className="w-40 shrink-0 truncate text-xs sm:w-56"
                  title={row.label}
                >
                  {row.label}
                  {/* Named, not colour-coded: two platforms would need two hues
                      and the hue would then encode platform while the bar
                      encodes volume. A word is unambiguous. */}
                  {row.platform === "instantly" ? (
                    <span className="ml-1.5 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                      Instantly
                    </span>
                  ) : null}
                </span>
                <span className="relative h-4 min-w-4 flex-1 overflow-hidden rounded bg-muted/60">
                  <span
                    className="absolute inset-y-0 left-0 rounded"
                    style={{
                      width: `${top ? (Number(row.sent) / top) * 100 : 0}%`,
                      backgroundColor: SENT,
                    }}
                  />
                </span>
                <span className="tnum w-16 shrink-0 text-right text-xs font-medium">
                  {fullNumber(row.sent)}
                </span>
                <span className="tnum w-12 shrink-0 text-right text-xs text-muted-foreground">
                  {row.grand_total
                    ? percent(Number(row.sent) / Number(row.grand_total), 1)
                    : "–"}
                </span>
              </div>
            ))}
          </div>
        )}

        <p className="border-t px-5 py-3 text-xs leading-relaxed text-muted-foreground">
          <strong className="font-medium text-foreground">Top 25.</strong> Shares are of all
          volume in range, not just the rows shown, so they will not sum to 100%.
        </p>
      </div>
    </div>
  );
}
