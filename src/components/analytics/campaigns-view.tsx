"use client";

import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAnalyticsFilters } from "./filters-context";
import { ColumnPicker, useColumnPrefs } from "./column-picker";
import { EmailPanel } from "./email-panel";
import { COLUMNS, type CampaignRow } from "@/lib/analytics/columns.ts";
import { SortableHeader } from "./sortable-header";
import { sortRows, useTableSort } from "@/hooks/use-table-sort";
import { fullNumber, percent } from "@/lib/analytics/format.ts";
import { cn } from "@/lib/utils";

interface Step {
  stepId: number;
  order: number | null;
  subject: string | null;
  body: string | null;
  waitInDays: number | null;
  isVariant: boolean;
  sent: number;
  replies: number;
  bounced: number;
  interested: number;
  /** Alternative wordings of THIS step. Empty for most steps. */
  variants?: Step[];
}

/**
 * Medals among a step and its variants (§5.3: "The best performers are marked
 * with a medal, so the winner is obvious without reading the percentages").
 *
 * Ranked on positive rate — the reason to run a variant at all — with a floor,
 * because the whole point of an A/B test is that the smaller arm must not win
 * on three replies. Below the floor nothing is marked, which is the honest
 * answer to "which is winning?" when the test has not run long enough.
 */
const VARIANT_MIN_SENT = 200;

function awardStepMedals(rows: Step[]): Map<number, string> {
  const out = new Map<number, string>();
  if (rows.length < 2) return out;

  const ranked = rows
    .filter((r) => r.sent >= VARIANT_MIN_SENT && r.replies > 0)
    .sort((a, b) => {
      const ar = a.replies ? a.interested / a.replies : 0;
      const br = b.replies ? b.interested / b.replies : 0;
      return br === ar ? b.sent - a.sent : br - ar;
    });

  // Only worth a medal if there is something to beat.
  if (ranked.length < 2) return out;
  ["🥇", "🥈", "🥉"].forEach((medal, i) => {
    if (ranked[i]) out.set(ranked[i].stepId, medal);
  });
  return out;
}

/** Lazily loads a campaign's steps — only once it's actually expanded. */
function StepRows({
  campaignId,
  colSpan,
}: {
  campaignId: number;
  colSpan: number;
}) {
  const { toQueryString } = useAnalyticsFilters();
  const qs = toQueryString();

  const { data, isLoading } = useQuery<{ steps: Step[] }>({
    queryKey: ["campaign-steps", campaignId, qs],
    queryFn: async () => {
      const response = await fetch(
        `/api/analytics/campaigns/${campaignId}/steps${qs ? `?${qs}` : ""}`,
      );
      if (!response.ok) throw new Error("Failed to load steps");
      return response.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <tr className="bg-muted/20">
        <td colSpan={colSpan} className="px-10 py-3">
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        </td>
      </tr>
    );
  }

  const steps = data?.steps ?? [];
  if (!steps.length) {
    return (
      <tr className="bg-muted/20">
        <td colSpan={colSpan} className="px-10 py-3 text-xs text-muted-foreground">
          No sequence steps recorded for this period.
        </td>
      </tr>
    );
  }

  return (
    <>
      {steps.map((step) => {
        const family = [step, ...(step.variants ?? [])];
        const medals = awardStepMedals(family);
        return (
          <Fragment key={step.stepId}>
            <StepRow step={step} colSpan={colSpan} medal={medals.get(step.stepId)} />
            {(step.variants ?? []).map((variant) => (
              <StepRow
                key={variant.stepId}
                step={variant}
                colSpan={colSpan}
                medal={medals.get(variant.stepId)}
                nested
              />
            ))}
          </Fragment>
        );
      })}
    </>
  );
}

function StepRow({
  step,
  colSpan,
  medal,
  nested = false,
}: {
  step: Step;
  colSpan: number;
  medal?: string;
  nested?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Fragment>
      <tr className="border-b bg-muted/20 text-xs">
        <td
          className={cn(
            "sticky left-0 z-10 bg-muted/20 py-2 pr-3",
            // Indented one level further so a variant reads as belonging to the
            // step above it rather than as another step.
            nested ? "pl-16" : "pl-10",
          )}
        >
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1.5 text-left hover:text-foreground"
          >
            <ChevronRight
              className={cn(
                "size-3 shrink-0 transition-transform",
                open && "rotate-90",
              )}
            />
            <span className="text-muted-foreground">
              {nested ? "Variant" : `Step ${step.order ?? "?"}`}
            </span>
            {medal ? <span title="Best positive rate">{medal}</span> : null}
            <span className="max-w-[260px] truncate">{step.subject ?? "—"}</span>
            {/*
              EmailBison defines wait_in_days as "how many days before the
              sequence moves to the NEXT step" — a delay AFTER this email. It
              was rendered as "wait 1d" against every step including the first,
              which reads as a delay before anything is sent; the first email
              goes out as soon as the lead enters. A variant has no gap of its
              own: it replaces its parent step at the same position.
            */}
            {!nested && step.waitInDays ? (
              <span className="text-[10px] text-muted-foreground/70">
                then wait {step.waitInDays}d
              </span>
            ) : null}
          </button>
        </td>
        <td className="tnum px-3 py-2 text-right">{fullNumber(step.sent)}</td>
        <td className="tnum px-3 py-2 text-right">{fullNumber(step.replies)}</td>
        <td className="tnum px-3 py-2 text-right">
          {percent(step.sent ? step.replies / step.sent : null, 2)}
        </td>
        <td className="tnum px-3 py-2 text-right">{fullNumber(step.bounced)}</td>
        <td colSpan={Math.max(0, colSpan - 5)} />
      </tr>

      {open ? (
        <tr className="border-b bg-muted/10">
          <td colSpan={colSpan} className="px-10 py-3">
            <EmailPanel subject={step.subject} body={step.body} />
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

export function CampaignsView() {
  const { toQueryString } = useAnalyticsFilters();
  const qs = toQueryString();
  const { visible, setVisible, hydrated } = useColumnPrefs();
  const [search, setSearch] = useState("");
  // No initial sort: the server already returns campaigns by volume, and the
  // third click returns to exactly that.
  const { sort, toggle } = useTableSort();
  const [expanded, setExpanded] = useState<Set<number | string>>(new Set());

  const query = useQuery<{ rows: CampaignRow[]; count: number }>({
    queryKey: ["campaigns", qs],
    queryFn: async () => {
      const response = await fetch(`/api/analytics/campaigns${qs ? `?${qs}` : ""}`);
      if (!response.ok) throw new Error("Failed to load campaigns");
      return response.json();
    },
  });

  const columns = useMemo(
    () => COLUMNS.filter((c) => visible.includes(c.key)),
    [visible],
  );

  const rows = useMemo(() => {
    const all = query.data?.rows ?? [];
    const filtered = search
      ? all.filter(
          (r) =>
            r.campaignName.toLowerCase().includes(search.toLowerCase()) ||
            (r.clientName ?? "").toLowerCase().includes(search.toLowerCase()),
        )
      : all;
    /*
     * Sorted through the column's own `sortValue`, so a rate sorts by its
     * number and a duration by its seconds. The old version cast the row key
     * unchecked and coerced with Number(), which silently turned every
     * unsortable value into 0.
     */
    const byKey = new Map(COLUMNS.map((c) => [c.key, c.sortValue]));
    return sortRows(filtered, sort, (row, key) => byKey.get(key)?.(row) ?? null);
  }, [query.data, search, sort]);

  if (query.isLoading || !hydrated) return <Skeleton className="h-96 w-full" />;

  // +1 for the pinned campaign-name column.
  const colSpan = columns.length + 1;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Campaign{" "}
          <span className="tnum font-medium text-foreground">
            {query.data?.count ?? 0}
          </span>
        </p>
        <div className="flex items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search campaigns…"
            className="h-8 w-56 text-xs"
          />
          <ColumnPicker visible={visible} onChange={setVisible} />
        </div>
      </div>

      {/* The grid is far wider than the viewport; the campaign name stays
          pinned so a row never loses its identity while scrolling sideways. */}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/30 text-[11px] uppercase tracking-wider text-muted-foreground">
              <th className="sticky left-0 z-20 min-w-[320px] bg-muted/30 px-3 py-2 text-left font-medium">
                Campaign
              </th>
              {columns.map((c) => (
                <SortableHeader
                  key={c.key}
                  label={c.label}
                  sortKey={c.sortValue ? c.key : undefined}
                  sort={sort}
                  onToggle={toggle}
                />
              ))}
            </tr>
          </thead>

          <tbody>
            {rows.map((row) => {
              const isOpen = expanded.has(row.campaignId);
              return (
                <Fragment key={row.campaignId}>
                  <tr className="border-b hover:bg-accent/30">
                    <td className="sticky left-0 z-10 bg-background px-3 py-2.5">
                      <button
                        type="button"
                        onClick={() =>
                          setExpanded((prev) => {
                            const next = new Set(prev);
                            if (next.has(row.campaignId)) next.delete(row.campaignId);
                            else next.add(row.campaignId);
                            return next;
                          })
                        }
                        className="flex w-full items-center gap-1.5 text-left"
                      >
                        <ChevronRight
                          className={cn(
                            "size-3.5 shrink-0 text-muted-foreground transition-transform",
                            isOpen && "rotate-90",
                          )}
                        />
                        <span className="max-w-[300px] truncate">
                          {row.campaignName}
                        </span>
                        {row.clientName ? (
                          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {row.clientName}
                          </span>
                        ) : null}
                        {/*
                          Steps and variants counted separately, and labelled.
                          A bare "4" beside a 3-step sequence was read as the
                          step count and disagreed with EmailBison.
                        */}
                        {row.stepCount ? (
                          <span className="shrink-0 text-[10px] text-muted-foreground/70">
                            {row.stepCount} step{row.stepCount === 1 ? "" : "s"}
                            {row.variantCount
                              ? ` · ${row.variantCount} variant${row.variantCount === 1 ? "" : "s"}`
                              : ""}
                          </span>
                        ) : null}
                      </button>
                    </td>
                    {columns.map((c) => (
                      <td
                        key={c.key}
                        className={cn(
                          "tnum whitespace-nowrap px-3 py-2.5 text-right",
                          c.emphasizeNonZero &&
                            Number(row[c.key as keyof CampaignRow] ?? 0) > 0 &&
                            "underline decoration-dotted underline-offset-2",
                        )}
                      >
                        {c.render(row)}
                      </td>
                    ))}
                  </tr>

                  {/*
                    Per-step stats are an EmailBison table keyed on an integer
                    campaign id. An Instantly row has neither, so it does not
                    expand — offering a chevron that opens an empty panel would
                    read as missing data rather than an absent feature.
                  */}
                  {isOpen && typeof row.campaignId === "number" ? (
                    <StepRows campaignId={row.campaignId} colSpan={colSpan} />
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {!rows.length ? (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="text-sm font-medium">No campaigns found</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Try a wider date range or clearing the search.
          </p>
        </div>
      ) : null}
    </div>
  );
}
