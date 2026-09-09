"use client";

import { KpiBand } from "./kpi-band";
import { Segmented } from "./segmented";
import { useAnalyticsFilters } from "./filters-context";
import { useKpis } from "./use-kpis";
import { ChartsView } from "./charts-view";
import { ClientsView } from "./clients-view";
import { CampaignsView } from "./campaigns-view";
import { RepliesView } from "./replies-view";
import { type SubView } from "@/lib/analytics/query-params.ts";

/*
 * The Campaign tab: KPI band, then a sub-view switcher.
 *
 * Sub-views are a URL param rather than separate routes because they share the
 * KPI band and every filter — a route change would remount the band and flash
 * it, which is exactly the shimmer the whole design is trying to avoid.
 *
 * All four sub-views from the spec are live. Replies was the last, and it is
 * the only one that needs lead attributes rather than campaign aggregates.
 */

const SUB_VIEW_OPTIONS: Array<{ value: SubView; label: string }> = [
  { value: "charts", label: "Charts" },
  { value: "clients", label: "Clients" },
  { value: "campaigns", label: "Campaigns" },
  { value: "replies", label: "Replies" },
];

export function CampaignTab() {
  const { filters, setFilters } = useAnalyticsFilters();
  const { cells, scope, isLoading } = useKpis();

  return (
    <>
      <KpiBand cells={cells} scope={scope} loading={isLoading} />

      <div className="border-b px-4">
        <Segmented
          aria-label="Sub-view"
          variant="full"
          value={filters.view}
          onValueChange={(view) => setFilters({ view })}
          options={SUB_VIEW_OPTIONS}
        />
      </div>

      <div className="flex-1 p-4">
        {filters.view === "charts" ? (
          <ChartsView />
        ) : filters.view === "clients" ? (
          <ClientsView />
        ) : filters.view === "replies" ? (
          <RepliesView />
        ) : (
          <CampaignsView />
        )}
      </div>
    </>
  );
}

