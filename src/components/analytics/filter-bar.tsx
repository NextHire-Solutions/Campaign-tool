"use client";

import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { useAnalyticsFilters } from "./filters-context";
import { QuickRangePills } from "./quick-range-pills";
import { RangePicker } from "./range-picker";
import { MultiSelect, type Option } from "./multi-select";
import { rangeLabel } from "@/lib/analytics/format.ts";
import { PLATFORMS, comparePeriod } from "@/lib/analytics/query-params.ts";

/*
 * The filter bar. Present on every analytics tab; whatever is set here applies
 * to every number and chart on the page.
 *
 * Whatever is set here applies to every number and chart on the page, and all
 * of it lives in the URL — so any view is a shareable link and the back button
 * steps through filter changes.
 */
const PLATFORM_LABEL: Record<string, string> = {
  emailbison: "EmailBison",
  instantly: "Instantly",
};

const PLATFORM_OPTIONS: Option[] = PLATFORMS.map((value) => ({
  value,
  label: PLATFORM_LABEL[value],
}));

/*
 * Labels match `reply_dimensions` exactly, and that is not cosmetic.
 *
 * This said "Brokerage" for `company`, while the breakdown cards on the same
 * screen show BOTH "Brokerage (client)" (the client the campaign belongs to)
 * and "Current brokerage" (`company` — where the person works today). So the
 * filter named after one card actually filtered the other.
 *
 * Only these three of the six dimensions are filterable from the bar; the rest
 * are reachable by clicking a row on their breakdown card, which drills the
 * reply list by that value.
 */
const REPLY_FACETS = [
  { key: "company", label: "Current brokerage" },
  { key: "location", label: "Location" },
  { key: "sales_volume", label: "Sales volume" },
] as const;

function ReplyFacetFilters() {
  const { filters, setFilters } = useAnalyticsFilters();

  const { data } = useQuery<{ facets: Record<string, Option[]> }>({
    queryKey: ["reply-facets", filters.from, filters.to],
    queryFn: async () => {
      const params = new URLSearchParams({ from: filters.from, to: filters.to, preset: "custom" });
      const response = await fetch(`/api/analytics/replies/facets?${params}`);
      if (!response.ok) throw new Error("Failed to load reply filters");
      return response.json();
    },
    staleTime: 5 * 60_000,
  });

  return (
    <>
      {REPLY_FACETS.map(({ key, label }) => (
        <MultiSelect
          key={key}
          label={label}
          options={data?.facets?.[key] ?? []}
          selected={filters.replyFacets[key] ?? []}
          onChange={(values) =>
            setFilters({ replyFacets: { ...filters.replyFacets, [key]: values } })
          }
          emptyText={`No ${label.toLowerCase()} values`}
        />
      ))}
    </>
  );
}

export function FilterBar() {
  const { filters, setFilters } = useAnalyticsFilters();
  const pathname = usePathname();

  /*
   * The bar is shared chrome, but the four tabs do not all consume it.
   *
   * Infrastructure reads none of it — every number there is a lifetime sender
   * total, scoped by team and nothing else — so it gets no bar at all rather
   * than five controls that change nothing. And `Compare previous` only ever
   * draws something on the Campaign tab (the KPI deltas and the chart's
   * overlay); on Attribution and Copy & Offer it was a checkbox with no effect,
   * which reads as a broken feature rather than an absent one.
   */
  const tab = pathname?.split("/")[2] ?? "campaign";
  const supportsCompare = tab === "campaign";

  /*
   * Platform, on every tab whose numbers actually change with it.
   *
   * This read `tab === "attribution"` for as long as Attribution was the only
   * place Instantly existed. That stopped being true when Instantly was synced
   * into the KPI band, the chart, the Clients and Campaigns tables and the
   * Volume split — the API routes have honoured `platforms` on all of them
   * since, so the filter WAS live and simply had no control to set it. A
   * working filter with no way to reach it is the same as a missing feature.
   *
   * Still absent from Copy & Offer, and that one is not an oversight: it reads
   * sequence copy and spintax, which only EmailBison exposes. Infrastructure
   * has no bar at all — it carries its own estate switch, because a Bison inbox
   * and an Instantly account do not share a column layout.
   */
  const supportsPlatform = tab === "attribution" || tab === "campaign" || tab === "volume";

  /*
   * The campaign filter, hidden where it does nothing.
   *
   * Volume answers two estate-level questions — how much can we send a day, and
   * where did the volume go — and its RPC takes no campaign parameter at all.
   * The control was therefore inert: selecting a campaign left the total at
   * 251,963 and every bar unchanged. That is the same failure the Compare
   * checkbox and the Platform dropdown were already hidden to avoid, and it is
   * worse here because the tab still LOOKS filtered.
   *
   * Not wired up instead of hidden, deliberately: capacity is a property of the
   * estate rather than of a campaign, so a campaign-filtered capacity figure
   * has no meaning, and the split already groups BY campaign — the rows a
   * filter would leave behind are the rows already on screen.
   */
  const supportsCampaignFilter = tab !== "volume";

  const { data: options } = useQuery<{ campaigns: Option[]; clients: Option[] }>({
    queryKey: ["filter-options"],
    queryFn: async () => {
      const r = await fetch("/api/analytics/filters");
      if (!r.ok) throw new Error("Failed to load filter options");
      return r.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const compare = filters.compare
    ? comparePeriod(filters.from, filters.to)
    : null;

  // After the hooks, never before — an early return above them would change the
  // hook order between tabs.
  if (tab === "infrastructure") return null;

  return (
    <div className="flex h-11 shrink-0 items-center gap-3 overflow-x-auto border-b px-4">
      <QuickRangePills />

      <Separator orientation="vertical" className="h-4" />

      <RangePicker />

      <Separator orientation="vertical" className="h-4" />

      {supportsCampaignFilter ? (
        <MultiSelect
          label="Campaigns"
          options={options?.campaigns ?? []}
          selected={filters.campaignIds.map(String)}
          onChange={(next) => setFilters({ campaignIds: next.map(Number) })}
          emptyText="No campaigns found"
        />
      ) : null}

      {/*
        §3 says this is "hidden when you're already looking at a single client".
        That refers to a per-client scope this app does not have — every screen
        here is workspace-wide, and there is no client portal. Hiding it when
        clientIds.length === 1 would be the opposite of the intent: that is
        someone who has FILTERED to one client, and taking the control away
        would leave them unable to change or clear it. Kept always visible.
      */}
      <MultiSelect
        label="Clients"
        options={options?.clients ?? []}
        selected={filters.clientIds}
        onChange={(clientIds) => setFilters({ clientIds })}
        emptyText="No clients found"
      />

      {/*
        Platform (WT §3). Clearing it means "both", never "neither" — an empty
        selection is the same request as ticking both boxes, which is why the
        routes send NULL for it rather than an empty array.
      */}
      {supportsPlatform ? (
        <MultiSelect
          label="Platform"
          options={PLATFORM_OPTIONS}
          selected={filters.platforms}
          onChange={(platforms) =>
            setFilters({ platforms: platforms as typeof filters.platforms })
          }
          emptyText="No platforms"
        />
      ) : null}

      {/*
        Reply attribute filters (REQ page 2), shown only on the Replies view.
        They describe the PERSON who replied, so on Charts or Campaigns — where
        a row is a day or a campaign — they would be controls that silently do
        nothing. Their values come from the data, capped at the 50 most common.
      */}
      {filters.view === "replies" ? <ReplyFacetFilters /> : null}

      {supportsCompare ? (
        <>
          <Separator orientation="vertical" className="h-4" />

          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={filters.compare}
              onCheckedChange={(checked) => setFilters({ compare: checked === true })}
              className="size-3.5"
            />
            Compare previous
          </label>

          {/* The comparison period is spelled out rather than left implicit —
              "vs the previous period" is exactly the kind of label that gets read
              three different ways by three different people. */}
          {compare ? (
            <span className="text-xs text-muted-foreground/70">
              vs {rangeLabel(compare.from, compare.to)}
            </span>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
