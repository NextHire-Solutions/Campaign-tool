"use client";

import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Loader2, Plus, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useAnalyticsFilters } from "./filters-context";
import { Segmented } from "./segmented";
import { fullNumber, percent } from "@/lib/analytics/format.ts";
import {
  STAGE_ORDER,
  TERMINAL_TYPES,
  outcomeLabel as outcomeTypeLabel,
} from "@/lib/analytics/outcomes.ts";
import { cn } from "@/lib/utils";

/*
 * The Replies sub-view (REQ "VIEW 3", spec §5.5).
 *
 * "What do our repliers have in common?" — the question that says where to
 * point the next campaign.
 *
 * TWO THINGS HERE ARE LOAD-BEARING RATHER THAN DECORATIVE.
 *
 * First, `Unknown` is drawn, not dropped. Lead attributes are only as complete
 * as the import that created them, and a bar chart that quietly omits the
 * people it has no data for looks identical to one where everybody is known —
 * except the conclusions drawn from it are wrong. Each card states its own
 * coverage when a meaningful share is unknown.
 *
 * Second, clicking a bar filters the list below through the SAME SQL function
 * that computed the bar (`reply_dimension_value`), so the number on the bar and
 * the number of rows you get cannot disagree.
 *
 * "Brokerage" here means the CLIENT we recruit for, resolved from the campaign —
 * no lead data needed, 97.8% coverage. "Current brokerage" is where the replying
 * agent works today. They answer different questions and are never merged.
 */

interface BreakdownRow {
  value: string;
  replies: number;
  positive: number;
}

interface Breakdown {
  key: string;
  label: string;
  bucket: string | null;
  rows: BreakdownRow[];
  /** Every group, not just the ones drawn. */
  total: number;
  groupCount: number;
  /** Summed over the drawn rows only. */
  shown: number;
  unknown: number;
}

interface CardsResponse {
  positiveOnly: boolean;
  dimensions: Array<{ key: string; label: string }>;
  breakdowns: Breakdown[];
}

interface ReplyRow {
  id: number;
  receivedAt: string;
  fromName: string | null;
  fromEmail: string | null;
  subject: string | null;
  preview: string | null;
  interested: boolean;
  automated: boolean;
  campaign: string | null;
  client: string | null;
  company: string | null;
  officeCity: string | null;
  salesVolume: string | null;
  /** Outcome types already logged by hand against this reply. */
  logged: string[];
}

interface RowsResponse {
  page: number;
  pageSize: number;
  total: number;
  rows: ReplyRow[];
}

/** Entity-fixed, matching the Replies and Positive series elsewhere. */
const BAR = "#eb6834";
const BAR_POSITIVE = "#008300";
const BAR_UNKNOWN = "#cbd5e1";

function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("rounded-xl border bg-card shadow-sm", className)}>{children}</div>;
}

const isUnknown = (value: string) => value === "Unknown" || value === "Unassigned";

/* ---------- one breakdown card ------------------------------------------ */

function BreakdownCard({
  breakdown,
  positiveOnly,
  selected,
  onSelect,
}: {
  breakdown: Breakdown;
  positiveOnly: boolean;
  selected: string | null;
  onSelect: (value: string | null) => void;
}) {
  const top = Math.max(...breakdown.rows.map((r) => r.replies), 1);
  const unknownShare = breakdown.total ? breakdown.unknown / breakdown.total : 0;

  return (
    <Card className="flex min-w-0 flex-col">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b px-4 py-3">
        <h3 className="text-sm font-semibold">{breakdown.label}</h3>
        <span className="text-xs tabular-nums text-muted-foreground">
          {fullNumber(breakdown.total)} {positiveOnly ? "positive" : "replies"}
        </span>
      </div>

      {breakdown.rows.length === 0 ? (
        // §5.5: says "No data available" plainly rather than showing an empty chart.
        <p className="flex-1 px-4 py-10 text-center text-sm text-muted-foreground">
          No data available
        </p>
      ) : (
        <div className="flex-1 space-y-1.5 px-4 py-3">
          {breakdown.rows.map((row) => {
            const active = selected === row.value;
            const unknown = isUnknown(row.value);
            return (
              <button
                key={row.value}
                type="button"
                onClick={() => onSelect(active ? null : row.value)}
                aria-pressed={active}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-1 py-0.5 text-left transition-colors",
                  active ? "bg-muted" : "hover:bg-muted/50",
                )}
              >
                <span
                  className={cn(
                    "w-28 shrink-0 truncate text-xs sm:w-36",
                    unknown && "text-muted-foreground",
                  )}
                  title={row.value}
                >
                  {row.value}
                </span>
                <span className="relative h-4 min-w-4 flex-1 overflow-hidden rounded bg-muted/60">
                  <span
                    className="absolute inset-y-0 left-0 rounded"
                    style={{
                      width: `${(row.replies / top) * 100}%`,
                      backgroundColor: unknown
                        ? BAR_UNKNOWN
                        : positiveOnly
                          ? BAR_POSITIVE
                          : BAR,
                    }}
                  />
                </span>
                <span className="w-10 shrink-0 text-right text-xs font-medium tabular-nums">
                  {fullNumber(row.replies)}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/*
        Coverage, stated only when it matters. A dimension answered for a
        minority of repliers cannot support a conclusion, and the card has to
        say so rather than looking confident.
      */}
      {unknownShare >= 0.2 || breakdown.groupCount > breakdown.rows.length ? (
        <p className="border-t px-4 py-2 text-[11px] leading-snug text-muted-foreground">
          {breakdown.groupCount > breakdown.rows.length ? (
            <>
              Top {breakdown.rows.length} of {fullNumber(breakdown.groupCount)}.{" "}
            </>
          ) : null}
          {unknownShare >= 0.2 ? (
            <>
              {percent(unknownShare, 0)} of these repliers have no{" "}
              {breakdown.label.toLowerCase()} on record — read the rest as a sample, not a
              total.
            </>
          ) : null}
        </p>
      ) : null}
    </Card>
  );
}

/* ---------- logging an outcome from a reply ----------------------------- */

/*
 * §7: "Outcomes reach the system two ways: logged by hand from a reply, or fed
 * in automatically from another system."
 *
 * Inline on the reply rather than behind a dialog: the operator is reading the
 * reply when they learn a call got booked, and a modal would make them lose it.
 * Already-logged types render as removable chips so the same outcome is never
 * recorded twice by someone who could not tell whether the first click worked.
 */
function LogOutcome({ reply }: { reply: ReplyRow }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const refresh = () => {
    for (const key of ["reply-rows", "attribution", "attribution-events", "reply-breakdowns"]) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  };

  const log = useMutation({
    mutationFn: async (eventType: string) => {
      const response = await fetch("/api/outcomes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ replyId: reply.id, eventType }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not log the outcome");
      return body;
    },
    onSuccess: () => {
      setOpen(false);
      refresh();
    },
  });

  const remove = useMutation({
    mutationFn: async (eventType: string) => {
      const id = `manual:${reply.id}:${eventType}`;
      const response = await fetch(`/api/outcomes?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not remove the outcome");
      return body;
    },
    onSuccess: refresh,
  });

  const busy = log.isPending || remove.isPending;

  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {reply.logged.map((type) => (
        <button
          key={type}
          type="button"
          disabled={busy}
          onClick={() => remove.mutate(type)}
          title="Remove this outcome"
          className="inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
        >
          {outcomeTypeLabel(type)}
          <X className="size-2.5" />
        </button>
      ))}

      {open ? (
        <select
          autoFocus
          aria-label="Outcome to log"
          disabled={busy}
          defaultValue=""
          onChange={(e) => e.target.value && log.mutate(e.target.value)}
          onBlur={() => setOpen(false)}
          className="h-6 rounded border bg-background px-1 text-[11px]"
        >
          <option value="">Choose…</option>
          {[...STAGE_ORDER, ...TERMINAL_TYPES]
            .filter((t) => !reply.logged.includes(t))
            .map((t) => (
              <option key={t} value={t}>
                {outcomeTypeLabel(t)}
              </option>
            ))}
        </select>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-2.5 animate-spin" /> : <Plus className="size-2.5" />}
          Log outcome
        </button>
      )}

      {log.error || remove.error ? (
        <span className="text-[11px] text-red-700">
          {(log.error ?? remove.error)?.message}
        </span>
      ) : null}
    </span>
  );
}

/* ---------- the reply list ---------------------------------------------- */

function ReplyList({
  positiveOnly,
  dimension,
  value,
  onClear,
}: {
  positiveOnly: boolean;
  dimension: string | null;
  value: string | null;
  onClear: () => void;
}) {
  const { toQueryString } = useAnalyticsFilters();
  const queryString = toQueryString();
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  /*
   * Page number is DERIVED, not reset in an effect.
   *
   * Any change to what is being asked for invalidates the page — asking for
   * page 7 of a freshly filtered list shows an empty table. The obvious fix is
   * `useEffect(() => setPage(1), [...deps])`, which the React Compiler lint
   * rejects outright, and rightly: it renders the stale page once before
   * correcting itself.
   *
   * Storing the page alongside the key it belongs to makes the reset happen
   * during render instead — no extra pass, no flash of the wrong rows.
   */
  const filterKey = `${queryString}|${positiveOnly}|${dimension}|${value}|${debounced}`;
  const [pageState, setPageState] = useState({ key: filterKey, page: 1 });
  const page = pageState.key === filterKey ? pageState.page : 1;
  const setPage = (next: (current: number) => number) =>
    setPageState({ key: filterKey, page: next(page) });

  const params = useMemo(() => {
    const next = new URLSearchParams(queryString);
    next.set("page", String(page));
    if (positiveOnly) next.set("positive", "1");
    if (dimension && value) {
      next.set("dimension", dimension);
      next.set("value", value);
    }
    if (debounced) next.set("q", debounced);
    return next;
  }, [queryString, page, positiveOnly, dimension, value, debounced]);

  const { data, isFetching } = useQuery<RowsResponse>({
    queryKey: ["reply-rows", params.toString()],
    queryFn: async () => {
      const response = await fetch(`/api/analytics/replies/rows?${params}`);
      if (!response.ok) throw new Error("Failed to load replies");
      return response.json();
    },
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / (data?.pageSize ?? 50)));

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">Replies</h2>
          {value ? (
            <button
              type="button"
              onClick={onClear}
              className="inline-flex items-center gap-1 rounded border bg-muted/50 px-1.5 py-0.5 text-xs hover:bg-muted"
            >
              {value}
              <X className="size-3 text-muted-foreground" />
            </button>
          ) : null}
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">
          {fullNumber(total)} matching{isFetching ? " · loading" : ""}
        </span>
      </div>

      <div className="border-b px-4 py-3 sm:px-5">
        <div className="relative max-w-full sm:max-w-72">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email or subject…"
            className="h-8 pl-8 text-sm"
          />
        </div>
      </div>

      {total === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-muted-foreground">
          No replies match these filters.
        </p>
      ) : (
        <ul className="divide-y">
          {(data?.rows ?? []).map((reply) => (
            <li key={reply.id} className="px-4 py-3 hover:bg-muted/40 sm:px-5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="min-w-0 truncate text-sm font-medium">
                  {reply.fromName || reply.fromEmail || "Unknown sender"}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {new Date(reply.receivedAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </span>
              </div>

              <p className="mt-0.5 truncate text-sm text-muted-foreground">
                {reply.subject || "(no subject)"}
              </p>

              {reply.preview ? (
                <p className="mt-1 line-clamp-2 text-xs leading-snug text-muted-foreground">
                  {reply.preview}
                </p>
              ) : null}

              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                {reply.interested ? (
                  <span className="rounded bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-700">
                    Positive
                  </span>
                ) : null}
                {reply.automated ? <span>Automated</span> : null}
                {reply.client ? <span>{reply.client}</span> : null}
                {reply.company ? <span>· {reply.company}</span> : null}
                {reply.officeCity ? <span>· {reply.officeCity}</span> : null}
                {reply.salesVolume ? <span>· {reply.salesVolume}</span> : null}
              </div>

              <div className="mt-2">
                <LogOutcome reply={reply} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {total > 0 ? (
        <div className="flex items-center justify-between border-t px-4 py-2.5 text-xs text-muted-foreground sm:px-5">
          <span className="tabular-nums">
            {(page - 1) * (data?.pageSize ?? 50) + 1}–
            {Math.min(page * (data?.pageSize ?? 50), total)} of {fullNumber(total)}
          </span>
          <span className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="rounded p-1 hover:bg-muted disabled:opacity-40"
              aria-label="Previous page"
            >
              <ChevronLeft className="size-4" />
            </button>
            <span className="tabular-nums">
              {page} / {pages}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
              disabled={page >= pages}
              className="rounded p-1 hover:bg-muted disabled:opacity-40"
              aria-label="Next page"
            >
              <ChevronRight className="size-4" />
            </button>
          </span>
        </div>
      ) : null}
    </Card>
  );
}

/* ---------- the view ---------------------------------------------------- */

export function RepliesView() {
  const { filters, toQueryString } = useAnalyticsFilters();
  const queryString = toQueryString();

  /*
   * Reply DETAIL is EmailBison-only, and this view says so rather than letting
   * the omission pass as an empty result.
   *
   * The KPI band above already counts Instantly's replies — it reads them from
   * the day stats, which are per-campaign totals. These cards need the reply
   * ROW: who sent it, from where, at what sales volume. That is a different
   * ingestion (Instantly's /emails, rate-capped at 20/min) and is not synced
   * yet, so with Instantly in scope the band's reply count and these cards
   * legitimately describe different populations. Unlabelled, that reads as a
   * bug in the cards.
   */
  const instantlyInScope = filters.platforms.includes("instantly");

  const [positiveOnly, setPositiveOnly] = useState(false);
  const [drill, setDrill] = useState<{ dimension: string; value: string } | null>(null);

  const cardsQuery = useMemo(() => {
    const next = new URLSearchParams(queryString);
    if (positiveOnly) next.set("positive", "1");
    return next.toString();
  }, [queryString, positiveOnly]);

  const { data, isLoading, isError } = useQuery<CardsResponse>({
    queryKey: ["reply-breakdowns", cardsQuery],
    queryFn: async () => {
      const response = await fetch(`/api/analytics/replies?${cardsQuery}`);
      if (!response.ok) throw new Error("Failed to load reply breakdowns");
      return response.json();
    },
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="m-4 rounded-xl border bg-card py-16 text-center text-sm text-muted-foreground">
        Could not load replies.
      </div>
    );
  }

  const anyData = data.breakdowns.some((b) => b.total > 0);

  return (
    <div className="space-y-4 bg-muted/30 p-3 sm:p-4 lg:p-6">
      {instantlyInScope ? (
        <p className="rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Reply breakdowns cover <strong>EmailBison only</strong>. Instantly&rsquo;s reply
          counts appear in the KPI band above, but the per-reply detail these cards
          need is not synced from Instantly yet.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        {/*
          One toggle, every chart. §5.5: "the fastest way to see whether a
          segment replies a lot or replies well."
        */}
        <Segmented
          aria-label="Reply set"
          value={positiveOnly ? "positive" : "all"}
          onValueChange={(v) => {
            setPositiveOnly(v === "positive");
            // The drill-down belongs to the previous population; keeping it
            // would show a bar's rows filtered by a set that no longer matches.
            setDrill(null);
          }}
          options={[
            { value: "all", label: "All replies" },
            { value: "positive", label: "Positive only" },
          ]}
        />
        <p className="text-xs text-muted-foreground">
          Grouped by who replied. Click a bar to filter the list below.
        </p>
      </div>

      {!anyData ? (
        <div className="rounded-xl border bg-card py-16 text-center">
          <p className="text-sm font-medium">No replies in this range</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Widen the date range, or clear the campaign and client filters.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {data.breakdowns.map((breakdown) => (
            <BreakdownCard
              key={breakdown.key}
              breakdown={breakdown}
              positiveOnly={positiveOnly}
              selected={drill?.dimension === breakdown.key ? drill.value : null}
              onSelect={(value) =>
                setDrill(value ? { dimension: breakdown.key, value } : null)
              }
            />
          ))}
        </div>
      )}

      <ReplyList
        positiveOnly={positiveOnly}
        dimension={drill?.dimension ?? null}
        value={drill?.value ?? null}
        onClear={() => setDrill(null)}
      />
    </div>
  );
}
