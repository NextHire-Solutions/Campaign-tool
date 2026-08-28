"use client";

import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ListOrdered, Loader2, Pencil, Plus, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SequenceDialog } from "@/components/campaigns/sequence-dialog";
import { SortableHeader } from "./sortable-header";
import { sortRows, useTableSort } from "@/hooks/use-table-sort";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAnalyticsFilters } from "@/components/analytics/filters-context";
import { CampaignPicker } from "@/components/analytics/campaign-picker";
import { SyncButton } from "@/components/analytics/sync-button";
import { CampaignMultiPicker } from "@/components/analytics/campaign-multi-picker";
import { BulkDeployPanel, useBulkDeploy } from "@/components/analytics/bulk-deploy";
import {
  COPY_DIMENSIONS, awardMedals, dimensionLabel, MEDAL_MIN_SENT,
} from "@/lib/analytics/copy-dimensions.ts";
import { compactNumber, fullNumber, percent, rangeLabel } from "@/lib/analytics/format.ts";
import { cn } from "@/lib/utils";

/*
 * Copy & Offer (spec §6), built to the reference screenshot.
 *
 * Offer groups sit on top as cards — one per offer, each carrying its combined
 * stats and the copy dimensions its sequence uses — with a dashed "Add Group"
 * card at the end. Below them a `Dimension:` row with removable chips and
 * "+ Add Dimension", then the performance table for whatever set is selected.
 *
 * The reframe, on the product owner's direction: an offer is not a label on
 * some campaigns, it is a REUSABLE SEQUENCE plus the evidence for it. Every
 * card can therefore push its sequence into another campaign in one click,
 * reusing the guided copy flow from §9.4 — including its audit snapshot and its
 * refusal to delete steps that have already sent.
 */

interface OfferRow {
  offer_id: string;
  offer_name: string;
  niche: string | null;
  campaigns: number;
  sent: number;
  replies: number;
  positive: number;
  bounced: number;
  reply_rate: number | null;
  positive_rate: number | null;
  bounce_rate: number | null;
  source: { source_campaign_id: number; source_name: string; step_count: number } | null;
  /*
   * Which clients run this offer, biggest first (REQ page 1: "aggregate
   * positive-rate by client/brand"). An offer that works for one brand and not
   * another is the thing worth knowing, and the single blended rate hides
   * exactly that.
   */
  clients?: Array<{
    client: string;
    campaigns: number;
    sent: number;
    replies: number;
    positive: number;
  }>;
}

interface Member {
  id: number;
  subject: string | null;
  campaign: string | null;
  sent: number;
  replies: number;
  positive: number;
  reply_rate: number | null;
  positive_rate: number | null;
  bounce_rate: number | null;
}

interface CopyRow {
  key: string;
  values: string[];
  members: Member[];
  steps: number;
  sent: number;
  replies: number;
  positive: number;
  bounced: number;
  /*
   * Campaign-level, summed per group: a meeting belongs to the conversation,
   * not to which email in the sequence opened it.
   */
  meetings: number;
  untagged: boolean;
  reply_rate: number | null;
  positive_rate: number | null;
  bounce_rate: number | null;
}

interface Suggestion {
  fingerprint: string;
  example_subject: string;
  variants: number;
  campaigns: number;
  campaign_ids: number[];
  source_campaign_id: number;
  source_name: string;
  step_count: number;
  claimed: number;
  sent: number;
  reply_rate: number | null;
  positive_rate: number | null;
  bounce_rate: number | null;
}

/** One campaign's copy-variation verdict. */
interface SpintaxRow {
  campaign_id: number;
  campaign_name: string;
  client_name: string | null;
  steps: number;
  spun_steps: number;
  variants: number;
  status: "spintax" | "partial" | "variants" | "none" | "unknown";
  sent: number;
}

interface CopyResponse {
  dimensions: string[];
  rows: CopyRow[];
  coverage: {
    tagged_sent: number; total_sent: number; tagged_steps: number; total_steps: number;
  };
  spintax: SpintaxRow[];
}

export function CopyOfferView() {
  // The same shared filter contract every analytics tab reads, so the date
  // range and client selection above apply here without a second parser.
  const { filters, toQueryString } = useAnalyticsFilters();
  const queryClient = useQueryClient();

  const [dimensions, setDimensions] = useState<string[]>(["subject_line"]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<OfferRow | null>(null);
  const deploy = useBulkDeploy();
  const [deploying, setDeploying] = useState<OfferRow | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const query = toQueryString();

  const suggestions = useQuery<{ suggestions: Suggestion[] }>({
    queryKey: ["offer-suggestions", query],
    queryFn: async () => {
      const response = await fetch(`/api/offers/suggestions?${query}`);
      if (!response.ok) throw new Error("Could not load suggestions");
      return response.json();
    },
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const offers = useQuery<{ rows: OfferRow[] }>({
    queryKey: ["offers", query],
    queryFn: async () => {
      const response = await fetch(`/api/offers?${query}`);
      if (!response.ok) throw new Error("Could not load offers");
      return response.json();
    },
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const copy = useQuery<CopyResponse>({
    queryKey: ["copy", query, dimensions],
    queryFn: async () => {
      const response = await fetch(`/api/copy?${query}&dimensions=${dimensions.join(",")}`);
      if (!response.ok) throw new Error((await response.json()).error ?? "Could not load copy");
      return response.json();
    },
    enabled: dimensions.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  /*
   * No initial sort. The server orders by positive rate with untagged sunk to
   * the bottom — "which copy WORKS, not which was sent most" — and that order
   * is the point of the table. The third click returns to it exactly.
   */
  const { sort, toggle } = useTableSort();
  const sortedRows = sortRows(copy.data?.rows ?? [], sort, (row, key) =>
    ((row as unknown as Record<string, unknown>)[key] ?? null),
  );
  /*
   * Untagged sinks to the bottom under EVERY sort, not just the default.
   *
   * It is not a copy choice — it is the absence of one — so ranking it against
   * real choices would put "we do not know" at the top of an ascending Positive
   * % sort and read as the worst-performing copy. The server already applies
   * this rule to its own ordering; sorting has to preserve it or the table
   * changes meaning the moment a header is clicked.
   */
  const rows = sort
    ? [...sortedRows.filter((r) => !r.untagged), ...sortedRows.filter((r) => r.untagged)]
    : sortedRows;
  /*
   * Untagged is a gap in the data, not a copy choice, so it cannot win a medal
   * — and being the largest bucket by volume it would take one every time until
   * tagging is done. It still appears in the table, because dropping it would
   * hide how partial the comparison is.
   */
  const medals = awardMedals(rows.filter((r) => !r.untagged));
  const coverage = copy.data?.coverage;
  /*
   * Only the campaigns with a verdict worth acting on, and only those that
   * actually sent in this window. A campaign with unvaried copy that sent
   * nothing is not a live problem, and listing it would bury the ones that are.
   */
  const unvaried = (copy.data?.spintax ?? []).filter(
    (r) => r.status === "none" && r.sent > 0,
  );
  const spintaxTotals = (copy.data?.spintax ?? []).reduce(
    (acc, r) => {
      if (r.status === "unknown") return acc;
      acc.sent += r.sent;
      if (r.status === "none") acc.unvariedSent += r.sent;
      return acc;
    },
    { sent: 0, unvariedSent: 0 },
  );
  const coverPct =
    coverage && coverage.total_sent > 0 ? coverage.tagged_sent / coverage.total_sent : null;

  const unused = COPY_DIMENSIONS.filter((d) => !dimensions.includes(d.key));

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-muted/30">
      <div className="space-y-5 p-6">
        {/*
          * A page-level header that ALWAYS renders.
          *
          * Sync first lived in the Suggested-groups header, which was wrong
          * twice over: it buried a page-level action inside a section, and that
          * section is conditional — so the button vanished exactly when the
          * cache was stale enough to have nothing to suggest, which is when you
          * need it most.
          */}
        {/* The progress panel sits above everything and stays put while the
            batch runs, so a failure is never scrolled out of view. */}
        <BulkDeployPanel
          batch={deploy.batch}
          running={deploy.running}
          onRetry={deploy.retryFailed}
          onDismiss={deploy.dismiss}
        />

        <header className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Copy &amp; Offer</h1>
          <p className="text-sm text-muted-foreground">
            Which words work, and which offers work
          </p>
          <div className="ml-auto">
            <SyncButton />
          </div>
        </header>

        {/* ---- Offer groups: only once at least one exists ---- */}
        {(offers.data?.rows?.length ?? 0) > 0 ? (
        <section>
          <div className="mb-3 flex items-baseline gap-3">
            <h2 className="text-base font-semibold tracking-tight">Offers</h2>
            <p className="text-sm text-muted-foreground">
              Combined performance, and the sequence behind each one
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {(offers.data?.rows ?? []).map((offer) => (
              <div key={offer.offer_id} className="rounded-xl border bg-card p-4 shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium" title={offer.offer_name}>
                      {offer.offer_name}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {offer.niche ?? "No niche set"} · {offer.campaigns}{" "}
                      {offer.campaigns === 1 ? "campaign" : "campaigns"}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={`Edit ${offer.offer_name}`}
                    onClick={() => setEditing(offer)}
                    className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <Pencil className="size-3.5" />
                  </button>
                </div>

                {offer.source ? (
                  <SequenceLink
                    campaignId={offer.source.source_campaign_id}
                    campaignName={offer.source.source_name}
                    stepCount={offer.source.step_count}
                  />
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">
                    No campaign attached yet — nothing to copy from.
                  </p>
                )}

                <dl className="mt-4 grid grid-cols-4 gap-2 text-center">
                  {(
                    [
                      ["Sent", compactNumber(offer.sent), ""],
                      ["Reply", percent(offer.reply_rate, 1), ""],
                      ["Positive", percent(offer.positive_rate, 1), "text-emerald-700"],
                      ["Bounce", percent(offer.bounce_rate, 1), ""],
                    ] as const
                  ).map(([label, value, tone]) => (
                    <div key={label}>
                      <dd className={cn("tnum text-sm font-semibold", tone)}>{value}</dd>
                      <dt className="text-[11px] text-muted-foreground">{label}</dt>
                    </div>
                  ))}
                </dl>

                {/*
                  The per-client split. Shown only when the offer runs for more
                  than one client — for a single-client offer it would just
                  restate the numbers directly above it.
                */}
                {(offer.clients?.length ?? 0) > 1 ? (
                  <div className="mt-3 border-t pt-2">
                    <p className="mb-1 text-[11px] font-medium text-muted-foreground">By client</p>
                    <ul className="space-y-0.5">
                      {offer.clients!.slice(0, 4).map((c) => (
                        <li
                          key={c.client}
                          className="flex items-baseline justify-between gap-2 text-[11px]"
                        >
                          <span className="min-w-0 truncate text-muted-foreground">{c.client}</span>
                          <span className="tnum shrink-0">
                            {compactNumber(c.sent)} ·{" "}
                            <span className="text-emerald-700">
                              {percent(c.replies > 0 ? c.positive / c.replies : null, 1)}
                            </span>
                          </span>
                        </li>
                      ))}
                      {offer.clients!.length > 4 ? (
                        <li className="text-[11px] text-muted-foreground">
                          +{offer.clients!.length - 4} more
                        </li>
                      ) : null}
                    </ul>
                  </div>
                ) : null}

                <Button
                  variant="outline"
                  size="sm"
                  disabled={!offer.source}
                  onClick={() => setDeploying(offer)}
                  className="mt-4 h-8 w-full gap-1.5 text-xs"
                >
                  <Send className="size-3" />
                  Copy sequence to a campaign
                </Button>
              </div>
            ))}

            {/* The dashed "Add Group" card from the reference. */}
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex min-h-[180px] flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            >
              <Plus className="size-5" />
              <span className="text-sm">Add Group</span>
            </button>
          </div>
        </section>
        ) : null}

        {/*
          * Proposed groups, discovered from the data.
          *
          * Campaigns that open with the same email ARE the same offer, and the
          * workspace already contains 36 on one subject and 24 on another.
          * Shipping an empty "Add Group" card asked the operator to reassemble
          * by hand something the database can see. Naming is the only part a
          * human is genuinely needed for, so that is the only part left to do.
          */}
        {(suggestions.data?.suggestions?.length ?? 0) > 0 ? (
          <section>
            <div className="mb-3 flex items-baseline gap-3">
              <h2 className="text-base font-semibold tracking-tight">Suggested groups</h2>
              <p className="text-sm text-muted-foreground">
                Campaigns that open with the same email — name one to turn it into an offer
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCreating(true)}
                className="ml-auto h-8 gap-1.5 text-sm"
              >
                <Plus className="size-3.5" />
                Add Group
              </Button>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {suggestions.data!.suggestions.slice(0, 8).map((s) => (
                <SuggestionCard
                  key={s.fingerprint}
                  suggestion={s}
                  onCreated={() => {
                    void queryClient.invalidateQueries({ queryKey: ["offers"] });
                    void queryClient.invalidateQueries({ queryKey: ["offer-suggestions"] });
                  }}
                />
              ))}
            </div>
          </section>
        ) : null}

        {/* ---- Copy that never changes ---- */}
        {unvaried.length ? (
          <section>
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 className="text-base font-semibold tracking-tight">Copy that never changes</h2>
              <p className="tnum text-xs text-muted-foreground">
                {fullNumber(spintaxTotals.unvariedSent)} of{" "}
                {fullNumber(spintaxTotals.sent)} sends in range
                {spintaxTotals.sent > 0
                  ? ` · ${percent(spintaxTotals.unvariedSent / spintaxTotals.sent, 0)}`
                  : ""}
              </p>
            </div>
            <p className="mb-3 max-w-3xl text-xs leading-relaxed text-muted-foreground">
              These campaigns use neither spintax{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                {"{{Hi | Hello | Hey}}"}
              </code>{" "}
              nor step variants, so every recipient gets a byte-identical message.
              {/*
                Named explicitly because the two are alternatives, not the same
                thing. 15 campaigns vary their copy with variants and no spintax;
                calling those unvaried would be wrong, and they are not listed.
              */}{" "}
              Campaigns that vary copy either way are not listed.
            </p>

            <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
              <table className="w-full table-fixed text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="w-[46%] px-4 py-2.5 font-normal">Campaign</th>
                    <th className="w-[22%] py-2.5 font-normal">Client</th>
                    <th className="w-[10%] py-2.5 text-right font-normal">Steps</th>
                    <th className="px-4 py-2.5 text-right font-normal">Sent in range</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {unvaried.slice(0, 12).map((row) => (
                    <tr key={row.campaign_id} className="transition-colors hover:bg-muted/40">
                      <td className="truncate px-4 py-2.5 font-medium" title={row.campaign_name}>
                        {row.campaign_name}
                      </td>
                      <td className="truncate px-3 py-2.5 text-muted-foreground">
                        {row.client_name ?? "—"}
                      </td>
                      <td className="tnum px-3 py-2.5 text-right text-muted-foreground">
                        {fullNumber(row.steps)}
                      </td>
                      <td className="tnum px-4 py-2.5 text-right font-medium">
                        {fullNumber(row.sent)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {unvaried.length > 12 ? (
                <p className="tnum border-t px-4 py-2 text-xs text-muted-foreground">
                  and {fullNumber(unvaried.length - 12)} more
                </p>
              ) : null}
            </div>
          </section>
        ) : null}

        {/* ---- Copy dimensions ---- */}
        <section>
          <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="text-base font-semibold tracking-tight">How the copy performs</h2>
            {/*
              §6.1: "The current period and sort are always spelled out above
              the table." Without it a reader has no way to know whether they
              are looking at 7 days or 90, and the ordering looks arbitrary.
            */}
            <p className="tnum text-xs text-muted-foreground">
              {rangeLabel(filters.from, filters.to)} · sorted by positive&nbsp;%
            </p>
            {/*
              * "Question 2.68%" is meaningless without saying what is being
              * compared. This line names the unit (an opening email), the
              * grouping, and the fact that a row opens.
              */}
            <p className="text-sm text-muted-foreground">
              Every campaign&apos;s opening email, grouped by how its{" "}
              {dimensions.map((d) => dimensionLabel(d).toLowerCase()).join(" and ")} was written.
              Open a row to see the actual emails in it.
            </p>
          </div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Dimension:</span>

            {dimensions.map((key) => (
              <span
                key={key}
                className="inline-flex items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1 text-sm shadow-sm"
              >
                {dimensionLabel(key)}
                <button
                  type="button"
                  aria-label={`Remove ${dimensionLabel(key)}`}
                  // Never remove the last one: an empty selection has no table
                  // to show, and a screen that can be emptied into nothing reads
                  // as broken rather than as a choice.
                  disabled={dimensions.length === 1}
                  onClick={() => setDimensions(dimensions.filter((d) => d !== key))}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}

            {unused.length ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 gap-1.5 text-sm">
                    <Plus className="size-3.5" />
                    Add Dimension
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64">
                  {unused.map((d) => (
                    <DropdownMenuItem
                      key={d.key}
                      onSelect={() => setDimensions([...dimensions, d.key])}
                      className="flex-col items-start gap-0.5"
                    >
                      <span className="text-sm">{d.label}</span>
                      <span className="text-xs text-muted-foreground">{d.hint}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}

            {copy.isFetching ? (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            ) : null}

            {coverPct === 0 ? (
              <SuggestTagsButton
                onDone={() => {
                  void queryClient.invalidateQueries({ queryKey: ["copy"] });
                  void queryClient.invalidateQueries({ queryKey: ["copy-tags"] });
                }}
              />
            ) : null}

            {coverPct != null ? (
              <p
                className={cn(
                  "ml-auto text-sm",
                  coverPct < 0.5 ? "text-amber-700" : "text-muted-foreground",
                )}
              >
                {/*
                  * Coverage, always. A ranking computed over a fraction of
                  * sending that presents itself as "how your copy performs" is
                  * worse than an empty table.
                  */}
                {percent(coverPct, 0)} of first-email sending tagged on{" "}
                {dimensions.length === 1 ? "this dimension" : "all these dimensions"}
              </p>
            ) : null}
          </div>

          <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
            <table className="w-full table-fixed text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  {dimensions.map((key, i) => (
                    <th key={key} className={cn("py-2.5 font-medium", i === 0 ? "pl-10 pr-4" : "px-4")}>
                      {dimensionLabel(key)}
                    </th>
                  ))}
                  <SortableHeader label="Steps" sortKey="steps" sort={sort} onToggle={toggle} className="w-[9%] py-2.5" />
                  <SortableHeader label="Sent" sortKey="sent" sort={sort} onToggle={toggle} className="w-[11%] py-2.5" />
                  <SortableHeader label="Replies" sortKey="replies" sort={sort} onToggle={toggle} className="w-[11%] py-2.5" />
                  <SortableHeader label={<>Reply&nbsp;%</>} sortKey="reply_rate" sort={sort} onToggle={toggle} className="w-[10%] py-2.5" />
                  <SortableHeader label={<>Positive&nbsp;%</>} sortKey="positive_rate" sort={sort} onToggle={toggle} className="w-[10%] py-2.5" />
                  <SortableHeader label={<>Bounce&nbsp;%</>} sortKey="bounce_rate" sort={sort} onToggle={toggle} className="w-[9%] py-2.5" />
                  {/* The counts behind the rates. "0.7% positive" over 23,428
                      sends reads very differently once you can see it is 152
                      people — §6.1 lists all four and the table showed none. */}
                  <SortableHeader label="Pos" sortKey="positive" sort={sort} onToggle={toggle} className="w-[7%] py-2.5" />
                  <SortableHeader label="Meetings" sortKey="meetings" sort={sort} onToggle={toggle} className="w-[8%] py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {copy.isLoading ? (
                  <tr>
                    <td colSpan={dimensions.length + 7} className="py-16 text-center">
                      <Loader2 className="mx-auto size-4 animate-spin text-muted-foreground" />
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={dimensions.length + 7}
                      className="px-4 py-16 text-center text-muted-foreground"
                    >
                      No data matches your criteria.
                      <span className="mt-1 block text-xs">
                        Tag a sequence step&apos;s copy dimensions from the Sequence tab of any
                        campaign, and it will appear here.
                      </span>
                    </td>
                  </tr>
                ) : (
                  rows.flatMap((row) => {
                    const medal = medals.get(row);
                    const open = expanded === row.key;
                    return [
                      <tr
                        key={row.key}
                        onClick={() => setExpanded(open ? null : row.key)}
                        className="cursor-pointer transition-colors hover:bg-muted/50"
                      >
                        {row.values.map((value, i) => (
                          <td
                            key={i}
                            className={cn("truncate py-2.5", i === 0 ? "pl-3 pr-4" : "px-4")}
                            title={value}
                          >
                            {i === 0 ? (
                              <span className="mr-1.5 inline-block align-middle text-muted-foreground">
                                {open ? (
                                  <ChevronDown className="size-4" />
                                ) : (
                                  <ChevronRight className="size-4" />
                                )}
                              </span>
                            ) : null}
                            {i === 0 && medal ? <span className="mr-1.5">{medal}</span> : null}
                            <span
                              className={cn(
                                value === "Untagged"
                                  ? "italic text-muted-foreground"
                                  : "font-medium",
                              )}
                            >
                              {value}
                            </span>
                          </td>
                        ))}
                        <td className="tnum px-3 py-2.5 text-right text-muted-foreground">
                          {fullNumber(row.steps)}
                        </td>
                        <td className="tnum px-3 py-2.5 text-right">{fullNumber(row.sent)}</td>
                        <td className="tnum px-3 py-2.5 text-right text-muted-foreground">
                          {fullNumber(row.replies)}
                        </td>
                        <td className="tnum px-3 py-2.5 text-right">
                          {percent(row.reply_rate, 2)}
                        </td>
                        <td className="tnum px-3 py-2.5 text-right font-medium">
                          {percent(row.positive_rate, 2)}
                        </td>
                        {/* A high bounce rate is coloured so a bad performer
                            cannot hide behind a decent reply rate (§6.1). */}
                        <td
                          className={cn(
                            "tnum px-3 py-2.5 text-right",
                            (row.bounce_rate ?? 0) >= 0.03 ? "font-medium text-[#b02525]" : "",
                          )}
                        >
                          {percent(row.bounce_rate, 2)}
                        </td>
                        <td className="tnum px-2 py-2.5 text-right">{fullNumber(row.positive)}</td>
                        <td className="tnum px-4 py-2.5 text-right">{fullNumber(row.meetings)}</td>
                      </tr>,

                      /*
                       * The emails behind the number. This is what makes the
                       * row mean something: "Direct wins" is only actionable
                       * once you can read the four subjects that are winning.
                       */
                      open ? (
                        <tr key={`${row.key}-open`} className="bg-muted/30">
                          <td colSpan={dimensions.length + 7} className="px-3 py-3">
                            <p className="mb-2 pl-7 text-xs text-muted-foreground">
                              {row.members.length} opening{" "}
                              {row.members.length === 1 ? "email" : "emails"} in this group
                            </p>
                            <table className="w-full table-fixed text-xs">
                              <thead>
                                <tr className="text-left text-muted-foreground">
                                  <th className="w-[42%] py-1 pl-7 pr-3 font-medium">Subject</th>
                                  <th className="w-[24%] px-3 py-1 font-medium">Campaign</th>
                                  <th className="px-3 py-1 text-right font-medium">Sent</th>
                                  <th className="px-3 py-1 text-right font-medium">Reply&nbsp;%</th>
                                  <th className="px-3 py-1 text-right font-medium">
                                    Positive&nbsp;%
                                  </th>
                                  <th className="px-3 py-1 text-right font-medium">
                                    Bounce&nbsp;%
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {row.members.map((m) => (
                                  <tr key={m.id}>
                                    <td
                                      className="truncate py-1 pl-7 pr-3"
                                      title={m.subject ?? ""}
                                    >
                                      {m.subject || (
                                        <em className="text-muted-foreground">No subject</em>
                                      )}
                                    </td>
                                    <td
                                      className="truncate px-3 py-1 text-muted-foreground"
                                      title={m.campaign ?? ""}
                                    >
                                      {m.campaign ?? "—"}
                                    </td>
                                    <td className="tnum px-3 py-1 text-right">
                                      {fullNumber(m.sent)}
                                    </td>
                                    <td className="tnum px-3 py-1 text-right">
                                      {percent(m.reply_rate, 2)}
                                    </td>
                                    <td className="tnum px-3 py-1 text-right">
                                      {percent(m.positive_rate, 2)}
                                    </td>
                                    <td
                                      className={cn(
                                        "tnum px-3 py-1 text-right",
                                        (m.bounce_rate ?? 0) >= 0.03 ? "text-[#b02525]" : "",
                                      )}
                                    >
                                      {percent(m.bounce_rate, 2)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      ) : null,
                    ];
                  })
                )}
              </tbody>
            </table>
          </div>

          {/*
            * The scope note is not a footnote people can skip: the numbers here
            * are deliberately smaller than the campaign totals, and without
            * this the difference reads as a bug.
            */}
          <p className="mt-2 text-xs text-muted-foreground">
            <strong className="font-medium text-foreground">First email only.</strong> Follow-ups
            are excluded: EmailBison inherits their subject from the step above, so counting them
            would count the same subject two or three times, and their replies belong to the
            opener that preceded them. Variants of the first email are included. Medals mark
            the best positive rate among values with at least{" "}
            {fullNumber(MEDAL_MIN_SENT)} sends, because without a floor the smallest sample wins
            every time.
          </p>
        </section>
      </div>

      <CreateOfferDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={() => {
          void queryClient.invalidateQueries({ queryKey: ["offers"] });
          void queryClient.invalidateQueries({ queryKey: ["offer-suggestions"] });
          setCreating(false);
        }}
      />
      <EditOfferDialog
        offer={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          /*
           * BOTH caches. Deleting an offer frees its campaigns, which makes the
           * group they came from suggestable again — but the suggestions query
           * kept serving its old empty result, so the group simply vanished.
           * Every offer mutation changes what is suggestable.
           */
          void queryClient.invalidateQueries({ queryKey: ["offers"] });
          void queryClient.invalidateQueries({ queryKey: ["offer-suggestions"] });
          setEditing(null);
        }}
      />
      <DeployDialog
        offer={deploying}
        onClose={() => setDeploying(null)}
        onStart={deploy.start}
      />
    </div>
  );
}

/*
 * The sequence behind a card, one click away.
 *
 * "Sequence: 3 steps from <campaign>" named the copy without showing it, so
 * reading the emails you were about to roll out meant leaving for the campaign
 * page. It is the same sentence — now it opens.
 */
function SequenceLink({
  campaignId,
  campaignName,
  stepCount,
}: {
  campaignId: number;
  campaignName: string;
  stepCount: number;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`View the full sequence from ${campaignName}`}
        className="group -mx-1.5 mt-2 flex w-[calc(100%+0.75rem)] items-center gap-1.5 rounded-md border border-transparent px-1.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:border-border hover:bg-accent/40 hover:text-foreground"
      >
        <ListOrdered className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {stepCount} {stepCount === 1 ? "step" : "steps"} from{" "}
          <span className="text-foreground">{campaignName}</span>
        </span>
        <ChevronRight className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
      </button>
      <SequenceDialog
        campaignId={campaignId}
        campaignName={campaignName}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

/** §6.2: "Create an offer with a name and the niche it targets." */
function CreateOfferDialog({
  open, onOpenChange, onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [niche, setNiche] = useState("");
  const [campaignId, setCampaignId] = useState<number | null>(null);


  const create = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/offers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          niche: niche || null,
          sourceCampaignId: campaignId,
          campaignIds: campaignId ? [campaignId] : [],
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not create the offer");
      return body;
    },
    onSuccess: () => {
      setName("");
      setNiche("");
      setCampaignId(null);
      onCreated();
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>New offer</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-medium">Name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Zillow Flex"
              className="mt-1 h-9 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium">Niche</span>
            <Input
              value={niche}
              onChange={(e) => setNiche(e.target.value)}
              placeholder="Real estate brokerages"
              className="mt-1 h-9 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium">Sequence from</span>
            <div className="mt-1">
              <CampaignPicker value={campaignId} onChange={setCampaignId} />
            </div>
            {/* The offer IS a sequence, so it needs one to be worth anything. */}
            <span className="mt-1 block text-[11px] text-muted-foreground">
              This campaign&apos;s sequence becomes the offer&apos;s, and is what gets copied to
              other campaigns.
            </span>
          </label>

          {create.error ? (
            <p className="rounded-md border border-red-300/60 bg-red-50 p-2 text-xs text-red-800">
              {create.error.message}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!name.trim() || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
            Create offer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One-click deploy.
 *
 * Reuses the §9.4 copy-sequence endpoint rather than a shortcut of its own, so
 * this inherits the whole safety story: the target's previous sequence is
 * snapshotted to the audit log before anything is written, Replace is refused
 * when a target step has already sent, and the "Re:" prefix is not
 * double-applied. "One click" describes the effort, not the number of checks.
 */
function DeployDialog({
  offer,
  onClose,
  onStart,
}: {
  offer: OfferRow | null;
  onClose: () => void;
  onStart: (batch: {
    sourceCampaignId: number;
    sourceLabel: string;
    mode: "append" | "replace";
    tasks: Array<{ campaignId: number; name: string; status: "pending" }>;
  }) => void;
}) {
  const [targetIds, setTargetIds] = useState<number[]>([]);
  const [mode, setMode] = useState<"append" | "replace">("append");

  const campaigns = useQuery<{ items: Array<{ id: number; name: string }> }>({
    queryKey: ["campaigns", "all", ""],
    queryFn: async () => {
      const response = await fetch("/api/campaigns?status=all");
      if (!response.ok) throw new Error("Failed to load campaigns");
      return response.json();
    },
    enabled: Boolean(offer),
    staleTime: 60_000,
  });

  /*
   * Preview every selected target, not just the first.
   *
   * With Replace the answer differs per campaign — one may have nothing to
   * delete while the next has a step that has already sent and cannot be
   * touched. A single preview would be a confident answer about the wrong
   * campaign.
   */
  const plans = useQuery({
    queryKey: ["copy-plan-many", offer?.offer_id, targetIds, mode],
    queryFn: async () => {
      const results = await Promise.all(
        targetIds.map(async (targetId) => {
          const response = await fetch(`/api/campaigns/${targetId}/copy-sequence`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sourceCampaignId: offer!.source!.source_campaign_id,
              mode,
              includeVariants: true,
              includeAttachments: true,
              apply: false,
            }),
          });
          const body = await response.json().catch(() => ({}));
          return {
            targetId,
            ok: response.ok,
            plan: body.plan as
              | { steps: unknown[]; removing: unknown[]; blocked: boolean; warnings: string[] }
              | undefined,
            error: body.error as string | undefined,
          };
        }),
      );
      return results;
    },
    enabled: Boolean(offer?.source) && targetIds.length > 0,
  });

  if (!offer) return null;

  const nameOf = (id: number) =>
    campaigns.data?.items.find((c) => c.id === id)?.name ?? `#${id}`;

  const blocked = (plans.data ?? []).filter((p) => p.plan?.blocked || !p.ok);
  const ready = (plans.data ?? []).filter((p) => p.ok && !p.plan?.blocked);
  const stepsEach = ready[0]?.plan?.steps.length ?? offer.source?.step_count ?? 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>Copy &ldquo;{offer.offer_name}&rdquo; to campaigns</DialogTitle>
        </DialogHeader>

        <div className="min-w-0 space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">
            {offer.source?.step_count} steps from{" "}
            <span className="text-foreground">{offer.source?.source_name}</span>
          </p>

          <div>
            <span className="text-xs font-medium">Target campaigns</span>
            <div className="mt-1">
              <CampaignMultiPicker
                value={targetIds}
                onChange={setTargetIds}
                exclude={offer.source?.source_campaign_id ?? null}
              />
            </div>
          </div>

          <div className="flex gap-3 text-xs">
            {(["append", "replace"] as const).map((m) => (
              <label key={m} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  checked={mode === m}
                  onChange={() => setMode(m)}
                  className="accent-foreground"
                />
                <span className="capitalize">{m}</span>
              </label>
            ))}
          </div>

          {plans.isFetching ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Checking {targetIds.length} {targetIds.length === 1 ? "campaign" : "campaigns"}…
            </p>
          ) : null}

          {ready.length ? (
            <p className="rounded-md border bg-muted/40 p-2 text-xs">
              <strong className="font-medium">{ready.length}</strong> ready ·{" "}
              {stepsEach} steps each
              {mode === "replace"
                ? ` · ${ready.reduce((n, p) => n + (p.plan?.removing.length ?? 0), 0)} existing steps will be deleted`
                : ""}
            </p>
          ) : null}

          {/*
            * Named, not counted. "3 will fail" tells you to go and find out
            * which; listing them with the reason is the whole point.
            */}
          {blocked.length ? (
            <div>
              <p className="mb-1 text-xs font-medium text-[#b02525]">
                {blocked.length} will be skipped
              </p>
              <ul className="max-h-28 space-y-1 overflow-y-auto rounded-md border border-red-300/60 bg-red-50/50 p-2 text-xs">
                {blocked.map((p) => (
                  <li key={p.targetId}>
                    <span className="block truncate font-medium">{nameOf(p.targetId)}</span>
                    <span className="block text-[#b02525]">
                      {p.error ?? p.plan?.warnings[0] ?? "Cannot be written to"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant={mode === "replace" ? "destructive" : "default"}
            disabled={!ready.length || plans.isFetching}
            onClick={() => {
              onStart({
                sourceCampaignId: offer.source!.source_campaign_id,
                sourceLabel: offer.offer_name,
                mode,
                // Only the ones that can actually take it. Queuing a known
                // failure just to report it later wastes a write attempt
                // against a live campaign.
                tasks: ready.map((p) => ({
                  campaignId: p.targetId,
                  name: nameOf(p.targetId),
                  status: "pending" as const,
                })),
              });
              onClose();
            }}
          >
            {mode === "replace" ? "Replace in" : "Copy to"} {ready.length}{" "}
            {ready.length === 1 ? "campaign" : "campaigns"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SuggestionCard({
  suggestion,
  onCreated,
}: {
  suggestion: Suggestion;
  onCreated: () => void;
}) {
  const [name, setName] = useState(suggestion.example_subject.replace(/\?$/, "").slice(0, 60));

  const create = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/offers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          sourceCampaignId: suggestion.source_campaign_id,
          campaignIds: suggestion.campaign_ids,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not create the offer");
      return body;
    },
    onSuccess: onCreated,
  });

  return (
    <div className="rounded-xl border border-dashed bg-card/60 p-4">
      <p className="truncate text-sm font-medium" title={suggestion.example_subject}>
        {suggestion.example_subject}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {suggestion.campaigns} campaigns
        {suggestion.variants > 1 ? ` · ${suggestion.variants} subject variants` : ""}
        {suggestion.claimed > 0 ? ` · ${suggestion.claimed} already in an offer` : ""}
      </p>

      {/* The same affordance as a real offer card — you are about to name this
          group, and the sequence is what you are naming. */}
      <SequenceLink
        campaignId={suggestion.source_campaign_id}
        campaignName={suggestion.source_name}
        stepCount={suggestion.step_count}
      />

      <dl className="mt-3 grid grid-cols-4 gap-2 text-center">
        {(
          [
            ["Sent", compactNumber(suggestion.sent), ""],
            ["Reply", percent(suggestion.reply_rate, 1), ""],
            ["Positive", percent(suggestion.positive_rate, 1), "text-emerald-700"],
            ["Bounce", percent(suggestion.bounce_rate, 1), ""],
          ] as const
        ).map(([label, value, tone]) => (
          <div key={label}>
            <dd className={cn("tnum text-sm font-semibold", tone)}>{value}</dd>
            <dt className="text-[11px] text-muted-foreground">{label}</dt>
          </div>
        ))}
      </dl>

      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name this offer"
        className="mt-3 h-8 text-xs"
      />
      <Button
        size="sm"
        variant="outline"
        disabled={!name.trim() || create.isPending}
        onClick={() => create.mutate()}
        className="mt-2 h-8 w-full text-xs"
      >
        {create.isPending ? <Loader2 className="mr-1.5 size-3 animate-spin" /> : null}
        Create offer from {suggestion.campaigns}{" "}
        {suggestion.campaigns === 1 ? "campaign" : "campaigns"}
      </Button>

      {create.error ? (
        <p className="mt-2 text-[11px] text-red-700">{create.error.message}</p>
      ) : null}
    </div>
  );
}

/**
 * Seeds subject-line tags so the dimension table has something to say on day
 * one. Only that dimension — see suggestSubjectLineType for why the other six
 * are left to humans.
 */
function SuggestTagsButton({ onDone }: { onDone: () => void }) {
  const run = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/copy/suggest", { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not suggest tags");
      return body as { suggested: number };
    },
    onSuccess: onDone,
  });

  return (
    <Button
      variant="outline"
      size="sm"
      className="h-8 gap-1.5 text-sm"
      disabled={run.isPending}
      onClick={() => run.mutate()}
      title="Reads each first email's subject and proposes its type. Marked as suggested until you confirm it."
    >
      {run.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
      Suggest subject types
    </Button>
  );
}

/**
 * Rename an offer, set its niche, and choose which campaign's sequence
 * represents it.
 *
 * Deleting is here too rather than on a separate screen, but it is deliberately
 * the least prominent control and it says what it does NOT do: removing the
 * label must never look like it might remove the campaigns.
 */
function EditOfferDialog({
  offer,
  onClose,
  onSaved,
}: {
  offer: OfferRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [niche, setNiche] = useState("");
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  // Seed the draft from the offer when a different one is opened. Done during
  // render rather than in an effect — the React Compiler lint rejects setState
  // in an effect, and this is the same pattern range-picker.tsx uses.
  if (offer && loadedFor !== offer.offer_id) {
    setLoadedFor(offer.offer_id);
    setName(offer.offer_name);
    setNiche(offer.niche ?? "");
    setSourceId(offer.source?.source_campaign_id ?? null);
  }


  const save = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/offers/${offer!.offer_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, niche: niche || null, sourceCampaignId: sourceId }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not save the offer");
      return body;
    },
    onSuccess: onSaved,
  });

  const remove = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/offers/${offer!.offer_id}`, { method: "DELETE" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not delete the offer");
      return body;
    },
    onSuccess: onSaved,
  });

  if (!offer) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>Edit offer</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-medium">Name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 h-9 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium">Niche</span>
            <Input
              value={niche}
              onChange={(e) => setNiche(e.target.value)}
              placeholder="Real estate brokerages"
              className="mt-1 h-9 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium">Sequence from</span>
            <div className="mt-1">
              <CampaignPicker
                value={sourceId}
                onChange={setSourceId}
                emptyLabel="Highest-volume campaign (automatic)"
              />
            </div>
            <span className="mt-1 block text-[11px] text-muted-foreground">
              Campaigns in an offer drift apart as they are edited, so this picks which version
              gets copied. Left automatic, it follows the highest-volume one.
            </span>
          </label>

          {(save.error ?? remove.error) ? (
            <p className="rounded-md border border-red-300/60 bg-red-50 p-2 text-xs text-red-800">
              {(save.error ?? remove.error)!.message}
            </p>
          ) : null}
        </div>

        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            disabled={remove.isPending}
            onClick={() => {
              if (
                window.confirm(
                  `Delete the offer "${offer.offer_name}"?\n\nIts ${offer.campaigns} campaigns are only detached — none of them is changed or deleted.`,
                )
              ) {
                remove.mutate();
              }
            }}
            className="text-red-700 hover:text-red-800"
          >
            Delete offer
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
