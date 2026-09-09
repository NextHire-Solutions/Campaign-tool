"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  Copy,
  LayoutGrid,
  List,
  Loader2,
  MoreHorizontal,
  Pause,
  Play,
  Inbox,
  RotateCw,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SortableHeader } from "@/components/analytics/sortable-header";
import { sortRows, useTableSort } from "@/hooks/use-table-sort";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AssignInboxesDialog } from "@/components/campaigns/assign-inboxes-dialog";
import { ClientPicker } from "@/components/campaigns/client-picker";
import { ReCampaignDialog } from "@/components/campaigns/re-campaign-dialog";
import { SyncButton } from "@/components/analytics/sync-button";
import { DASH, fullNumber, percent } from "@/lib/analytics/format.ts";
import {
  CAMPAIGN_STATUSES,
  STATUS_TONE,
  canApply,
  isKnownStatus,
  whyNot,
  type CampaignAction,
} from "@/lib/campaigns/status.ts";
import { cn } from "@/lib/utils";

/*
 * The campaign list (spec §9.1).
 *
 * Everything here changes what real prospects receive, so the shape of the code
 * follows the spec's rule rather than convenience: nothing is applied
 * optimistically, every action names its targets before it runs, and the result
 * is reported per campaign because a bulk pause can genuinely half-succeed.
 */

interface Campaign {
  id: number;
  name: string;
  status: string;
  tags: unknown[];
  /*
   * Lifetime figures, as §11 asks the carried-over table to show. Labelled
   * lifetime in the header because they are NOT date-filtered — this screen has
   * no range picker, and a reply rate that silently meant "all time" while
   * looking like "this month" is the kind of number people quote in meetings.
   */
  lifetime_unique_replies: number | null;
  completion_percentage: number | null;
  total_leads: number | null;
  lifetime_emails_sent: number | null;
  max_emails_per_day: number | null;
  eb_updated_at: string | null;
  clientName: string | null;
  excluded: boolean;
}

interface ListResponse {
  items: Campaign[];
  total: number;
  statusCounts: Record<string, number>;
  all: number;
  clients: Array<{ id: string; name: string }>;
  /** Distinct tag names in use, read from the data rather than hardcoded. */
  tags?: string[];
}

interface ActionResult {
  campaignId: number;
  name: string;
  ok: boolean;
  status?: string;
  error?: string;
  skipped?: boolean;
}

const ACTION_LABEL: Record<CampaignAction, string> = {
  pause: "Pause",
  resume: "Resume",
  archive: "Archive",
  duplicate: "Duplicate",
};

const ACTION_ICON: Record<CampaignAction, typeof Pause> = {
  pause: Pause,
  resume: Play,
  archive: Archive,
  duplicate: Copy,
};

/** "about 13 hours ago" — the spec asks for plain language, not a timestamp. */
function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `about ${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : `${Math.round(days / 30)}mo ago`;
}

/**
 * How far through its leads a campaign is.
 *
 * A bar plus the number, because a bar alone cannot tell 97% from 100% at this
 * width — and "nearly finished" versus "finished" is the difference between
 * leaving it alone and queueing more leads. Renders a dash when EmailBison has
 * not reported a percentage rather than an empty track, which would read as 0%.
 */
function ProgressBar({ value }: { value: number | null }) {
  if (value === null || !Number.isFinite(value)) {
    return <span className="text-xs text-muted-foreground">{DASH}</span>;
  }
  const pct = Math.max(0, Math.min(100, value));
  return (
    <span className="flex items-center gap-1.5" title={`${pct.toFixed(1)}% complete`}>
      <span className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
        <span
          className={cn("block h-full rounded-full", pct >= 99 ? "bg-muted-foreground" : "bg-foreground")}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="tnum w-8 shrink-0 text-right text-[10px] text-muted-foreground">
        {Math.round(pct)}%
      </span>
    </span>
  );
}

function StatusChip({ status }: { status: string }) {
  const tone = isKnownStatus(status)
    ? STATUS_TONE[status]
    : "bg-red-100 text-red-800"; // visible, because an unknown status is drift
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium capitalize",
        tone,
      )}
    >
      <span className="size-1.5 rounded-full bg-current opacity-70" />
      {status}
    </span>
  );
}

export function CampaignsPage() {
  const queryClient = useQueryClient();

  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState("");
  const [clientId, setClientId] = useState("");
  const [view, setView] = useState<"list" | "grid">("list");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [pending, setPending] = useState<{ action: CampaignAction; ids: number[] } | null>(null);
  const [assigningInboxes, setAssigningInboxes] = useState(false);
  const [reCampaigning, setReCampaigning] = useState(false);
  const [results, setResults] = useState<{ action: CampaignAction; results: ActionResult[] } | null>(
    null,
  );

  const { data, isFetching } = useQuery<ListResponse>({
    queryKey: ["campaigns", status, search, tag, clientId],
    queryFn: async () => {
      const params = new URLSearchParams({ status });
      if (search) params.set("q", search);
      if (tag) params.set("tag", tag);
      if (clientId) params.set("client_id", clientId);
      const response = await fetch(`/api/campaigns?${params}`);
      if (!response.ok) throw new Error("Failed to load campaigns");
      return response.json();
    },
    // Keeps the current rows on screen while a new filter loads, so typing in
    // the search box doesn't flash an empty table on every keystroke.
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  /*
   * Server order is lifetime volume. No initial sort, so the third click puts
   * it back exactly.
   */
  const { sort, toggle } = useTableSort();
  const items = useMemo(
    () =>
      sortRows(data?.items ?? [], sort, (row, key) =>
        (row as unknown as Record<string, unknown>)[key] ?? null,
      ),
    [data, sort],
  );

  const apply = useMutation({
    mutationFn: async ({ action, ids }: { action: CampaignAction; ids: number[] }) => {
      const response = await fetch("/api/campaigns/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, campaignIds: ids, confirm: true }),
      });
      const body = await response.json();
      if (!response.ok && response.status !== 207) {
        throw new Error(body.error ?? "The action could not be applied");
      }
      return body as { action: CampaignAction; results: ActionResult[] };
    },
    onSuccess: (body) => {
      setResults({ action: body.action, results: body.results });
      setSelected(new Set());
      // Refetch rather than patch in place: the server already wrote the new
      // status through, and re-reading is how the screen stays a report of
      // what EmailBison has rather than what we hoped it would have.
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
    },
  });

  const selectedCampaigns = items.filter((c) => selected.has(c.id));

  /** Only the campaigns an action can actually apply to — the rest are named, not sent. */
  const eligible = (action: CampaignAction, list: Campaign[]) =>
    list.filter((c) => canApply(action, c.status));

  function toggleAll() {
    setSelected(selected.size === items.length ? new Set() : new Set(items.map((c) => c.id)));
  }

  const pendingCampaigns = pending
    ? items.filter((c) => pending.ids.includes(c.id))
    : [];
  const pendingEligible = pending ? eligible(pending.action, pendingCampaigns) : [];
  const pendingLeads = pendingEligible.reduce((sum, c) => sum + (c.total_leads ?? 0), 0);

  const statusTabs = [
    { key: "all", label: "All", count: data?.all },
    { key: "active", label: "Active", count: data?.statusCounts?.active },
    { key: "paused", label: "Paused", count: data?.statusCounts?.paused },
  ];

  const moreStatuses = CAMPAIGN_STATUSES.filter(
    (s) => !["active", "paused"].includes(s),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-6">
        <h1 className="text-sm font-medium">Campaigns</h1>
        <span className="tnum text-xs text-muted-foreground">{data?.total ?? 0}</span>
        {isFetching ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        ) : null}
        <div className="ml-auto">
          <SyncButton />
        </div>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-6 py-2.5">
        <div className="flex items-center gap-0.5 rounded-md border p-0.5">
          {statusTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setStatus(tab.key)}
              className={cn(
                "rounded px-2.5 py-1 text-xs transition-colors",
                status === tab.key
                  ? "bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
              {tab.count !== undefined ? (
                <span className="tnum ml-1.5 text-muted-foreground">{tab.count}</span>
              ) : null}
            </button>
          ))}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  "rounded px-2.5 py-1 text-xs transition-colors",
                  !["all", "active", "paused"].includes(status)
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {!["all", "active", "paused"].includes(status) ? status : "More"} ▾
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44">
              {moreStatuses.map((s) => (
                <DropdownMenuItem
                  key={s}
                  onSelect={() => setStatus(s)}
                  className="justify-between text-xs capitalize"
                >
                  {s}
                  <span className="tnum text-muted-foreground">
                    {data?.statusCounts?.[s] ?? 0}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="relative min-w-[200px] flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search campaigns…"
            className="h-8 pl-8 text-xs"
          />
        </div>

        {/*
          Client filter. The route already understood `client_id`; only the
          control was missing, which is why this is a select and not a new
          query path. Unassigned is offered as a real choice: a campaign whose
          name matched no client is exactly the thing worth listing, and it is
          invisible under every named client.
        */}
        {(data?.clients?.length ?? 0) > 0 ? (
          <ClientPicker
            clients={data!.clients!}
            value={clientId}
            onChange={setClientId}
          />
        ) : null}

        {/*
          Tag filter (WT §9.1, REQ page 4). Rendered only when tags exist —
          an always-present control offering nothing but "All tags" is a dead
          affordance that makes the toolbar look broken.
        */}
        {(data?.tags?.length ?? 0) > 0 ? (
          <select
            aria-label="Filter by tag"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            className="h-8 shrink-0 rounded-md border bg-background px-2 text-xs"
          >
            <option value="">All tags</option>
            {data!.tags!.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        ) : null}

        <div className="ml-auto flex items-center gap-0.5 rounded-md border p-0.5">
          {(["list", "grid"] as const).map((mode) => {
            const Icon = mode === "list" ? List : LayoutGrid;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => setView(mode)}
                aria-label={mode === "list" ? "List view" : "Grid view"}
                aria-pressed={view === mode}
                className={cn(
                  "rounded p-1.5 transition-colors",
                  view === mode
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-3.5" />
              </button>
            );
          })}
        </div>
      </div>

      <AssignInboxesDialog
        campaignIds={[...selected]}
        open={assigningInboxes}
        onOpenChange={setAssigningInboxes}
        onDone={() => setSelected(new Set())}
      />

      {/* Mounted only with a single selection, so the dialog can never be
          handed an ambiguous source campaign. */}
      {selectedCampaigns.length === 1 ? (
        <ReCampaignDialog
          campaignId={selectedCampaigns[0].id}
          campaignName={selectedCampaigns[0].name}
          open={reCampaigning}
          onOpenChange={setReCampaigning}
        />
      ) : null}

      {selected.size > 0 ? (
        <div className="flex shrink-0 items-center gap-2 border-b bg-accent/40 px-6 py-2">
          <span className="tnum text-xs font-medium">{selected.size} selected</span>
          {(["pause", "resume", "archive", "duplicate"] as CampaignAction[]).map((action) => {
            const count = eligible(action, selectedCampaigns).length;
            const Icon = ACTION_ICON[action];
            return (
              <Button
                key={action}
                variant="outline"
                size="sm"
                disabled={count === 0}
                onClick={() => setPending({ action, ids: [...selected] })}
                className="h-7 gap-1.5 text-xs"
              >
                <Icon className="size-3" />
                {ACTION_LABEL[action]}
                {/* The count is the honest headline: "Pause 12" when 25 are
                    selected tells you 13 aren't running before you click. */}
                {count !== selected.size ? (
                  <span className="tnum text-muted-foreground">{count}</span>
                ) : null}
              </Button>
            );
          })}
          {/*
            Separated from the status actions because it is a different kind of
            change: pause/resume/archive move a campaign through its lifecycle,
            this one decides which mailboxes send for it. It also has no
            eligibility rule — any campaign can be given inboxes.
          */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAssigningInboxes(true)}
            className="h-7 gap-1.5 text-xs"
          >
            <Inbox className="size-3" />
            Inboxes
          </Button>
          {/*
            Client feedback: re-campaign was reachable only from a campaign's
            own Sequence tab. It builds ONE new campaign from ONE source, so it
            is offered only when a single campaign is selected — a bulk version
            would have to invent a name per campaign and would create as many
            drafts as were ticked, which is not what ticking implies.
          */}
          <Button
            variant="outline"
            size="sm"
            disabled={selected.size !== 1}
            title={
              selected.size === 1
                ? undefined
                : "Select exactly one campaign to re-campaign it"
            }
            onClick={() => setReCampaigning(true)}
            className="h-7 gap-1.5 text-xs"
          >
            <RotateCw className="size-3" />
            Re-campaign
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelected(new Set())}
            className="ml-auto h-7 text-xs"
          >
            Clear
          </Button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {items.length === 0 ? (
          <p className="p-10 text-center text-sm text-muted-foreground">
            {search ? `No campaigns match "${search}"` : "No campaigns found"}
          </p>
        ) : view === "list" ? (
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-background">
              <tr className="border-b text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="w-9 px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label="Select all campaigns"
                    checked={selected.size === items.length && items.length > 0}
                    onChange={toggleAll}
                    className="size-3.5 align-middle accent-foreground"
                  />
                </th>
                <SortableHeader label="Campaign" sortKey="name" align="left" sort={sort} onToggle={toggle} className="px-2 py-2" />
                <SortableHeader label="Client" sortKey="clientName" align="left" sort={sort} onToggle={toggle} className="px-2 py-2" />
                <SortableHeader label="Status" sortKey="status" align="left" sort={sort} onToggle={toggle} className="px-2 py-2" />
                <SortableHeader label="Sent" sortKey="lifetime_emails_sent" sort={sort} onToggle={toggle} className="px-2 py-2" />
                <SortableHeader label="Replies" sortKey="lifetime_unique_replies" sort={sort} onToggle={toggle} className="px-2 py-2" />
                <SortableHeader label="Leads" sortKey="total_leads" sort={sort} onToggle={toggle} className="px-2 py-2" />
                <SortableHeader label="Progress" sortKey="completion_percentage" align="left" sort={sort} onToggle={toggle} className="w-28 px-2 py-2" />
                <SortableHeader label="Updated" sortKey="eb_updated_at" align="left" sort={sort} onToggle={toggle} className="px-2 py-2" />
                <th className="w-9 px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {items.map((campaign) => (
                <tr
                  key={campaign.id}
                  className={cn(
                    "border-b transition-colors hover:bg-accent/40",
                    selected.has(campaign.id) && "bg-accent/30",
                  )}
                >
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={`Select ${campaign.name}`}
                      checked={selected.has(campaign.id)}
                      onChange={() => {
                        const next = new Set(selected);
                        if (next.has(campaign.id)) next.delete(campaign.id);
                        else next.add(campaign.id);
                        setSelected(next);
                      }}
                      className="size-3.5 align-middle accent-foreground"
                    />
                  </td>
                  <td className="max-w-[380px] px-2 py-2">
                    <Link
                      href={`/campaigns/${campaign.id}`}
                      className="block truncate hover:underline"
                      title={campaign.name}
                    >
                      {campaign.name}
                    </Link>
                  </td>
                  <td className="px-2 py-2 text-xs text-muted-foreground">
                    {campaign.excluded ? (
                      <span className="italic opacity-70">excluded</span>
                    ) : (
                      (campaign.clientName ?? <span className="opacity-70">Unassigned</span>)
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <StatusChip status={campaign.status} />
                  </td>
                  <td className="tnum px-2 py-2 text-right text-xs">
                    {fullNumber(campaign.lifetime_emails_sent)}
                  </td>
                  {/*
                    Replies with the rate beside it (§11). The rate is the point:
                    289 replies means nothing until you know whether that came
                    from 18,000 sends or 1,000.
                  */}
                  <td className="tnum px-2 py-2 text-right text-xs">
                    {fullNumber(campaign.lifetime_unique_replies)}
                    {campaign.lifetime_emails_sent && campaign.lifetime_unique_replies ? (
                      <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                        {percent(
                          campaign.lifetime_unique_replies / campaign.lifetime_emails_sent,
                          2,
                        )}
                      </span>
                    ) : null}
                  </td>
                  <td className="tnum px-2 py-2 text-right text-xs text-muted-foreground">
                    {fullNumber(campaign.total_leads)}
                  </td>
                  <td className="px-2 py-2">
                    <ProgressBar value={campaign.completion_percentage} />
                  </td>
                  <td className="px-2 py-2 text-xs text-muted-foreground">
                    {relativeTime(campaign.eb_updated_at)}
                  </td>
                  <td className="px-2 py-2">
                    <RowMenu
                      campaign={campaign}
                      onAction={(action) => setPending({ action, ids: [campaign.id] })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {items.map((campaign) => (
              <div
                key={campaign.id}
                className={cn(
                  "flex flex-col gap-2 rounded-lg border bg-card p-3",
                  selected.has(campaign.id) && "ring-1 ring-foreground/20",
                )}
              >
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    aria-label={`Select ${campaign.name}`}
                    checked={selected.has(campaign.id)}
                    onChange={() => {
                      const next = new Set(selected);
                      if (next.has(campaign.id)) next.delete(campaign.id);
                      else next.add(campaign.id);
                      setSelected(next);
                    }}
                    className="mt-0.5 size-3.5 shrink-0 accent-foreground"
                  />
                  <Link
                    href={`/campaigns/${campaign.id}`}
                    className="min-w-0 flex-1 text-sm leading-snug hover:underline"
                    title={campaign.name}
                  >
                    {campaign.name}
                  </Link>
                  <RowMenu
                    campaign={campaign}
                    onAction={(action) => setPending({ action, ids: [campaign.id] })}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <StatusChip status={campaign.status} />
                  <span className="truncate text-xs text-muted-foreground">
                    {campaign.clientName ?? "Unassigned"}
                  </span>
                </div>
                <div className="tnum flex gap-4 text-xs text-muted-foreground">
                  <span>{fullNumber(campaign.lifetime_emails_sent)} sent</span>
                  <span>{fullNumber(campaign.total_leads)} leads</span>
                  <span className="ml-auto">{relativeTime(campaign.eb_updated_at)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        pending={pending}
        campaigns={pendingCampaigns}
        eligible={pendingEligible}
        leads={pendingLeads}
        running={apply.isPending}
        error={apply.error?.message ?? null}
        onCancel={() => {
          setPending(null);
          apply.reset();
        }}
        onConfirm={() => {
          if (!pending) return;
          apply.mutate(
            { action: pending.action, ids: pendingEligible.map((c) => c.id) },
            { onSuccess: () => setPending(null) },
          );
        }}
      />

      <ResultDialog results={results} onClose={() => setResults(null)} />
    </div>
  );
}

function RowMenu({
  campaign,
  onAction,
}: {
  campaign: Campaign;
  onAction: (action: CampaignAction) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${campaign.name}`}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <MoreHorizontal className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {(["pause", "resume", "duplicate", "archive"] as CampaignAction[]).map((action) => {
          const allowed = canApply(action, campaign.status);
          const Icon = ACTION_ICON[action];
          return (
            <DropdownMenuItem
              key={action}
              disabled={!allowed}
              onSelect={() => onAction(action)}
              className="gap-2 text-xs"
              // Disabled items keep their reason rather than just greying out,
              // so "why can't I resume this?" is answered in place.
              title={allowed ? undefined : whyNot(action, campaign.status)}
            >
              <Icon className="size-3.5" />
              {ACTION_LABEL[action]}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ConfirmDialog({
  pending,
  campaigns,
  eligible,
  leads,
  running,
  error,
  onCancel,
  onConfirm,
}: {
  pending: { action: CampaignAction; ids: number[] } | null;
  campaigns: Campaign[];
  eligible: Campaign[];
  leads: number;
  running: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!pending) return null;
  const skipped = campaigns.length - eligible.length;

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {ACTION_LABEL[pending.action]} {eligible.length}{" "}
            {eligible.length === 1 ? "campaign" : "campaigns"}?
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm">
              {/*
                * Resume is the one action that can start sending to real
                * people, and it does NOT restore the previous status — it
                * queues the campaign. Naming the lead count turns this from a
                * yes/no into an informed decision.
                */}
              {pending.action === "resume" ? (
                <p className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 p-2.5 text-xs text-amber-900">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    Resuming queues these campaigns to send.{" "}
                    <strong className="tnum">{fullNumber(leads)}</strong> leads are attached and
                    may begin receiving email. This does not restore a previous status.
                  </span>
                </p>
              ) : null}

              {skipped > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {skipped} of {campaigns.length} selected{" "}
                  {skipped === 1 ? "campaign is" : "campaigns are"} not eligible and will be left
                  alone.
                </p>
              ) : null}

              <ul className="max-h-44 space-y-0.5 overflow-y-auto rounded-md border p-2 text-xs">
                {eligible.map((c) => (
                  <li key={c.id} className="flex items-center gap-2">
                    <StatusChip status={c.status} />
                    <span className="truncate">{c.name}</span>
                  </li>
                ))}
              </ul>

              {error ? (
                <p className="rounded-md border border-red-300/60 bg-red-50 p-2 text-xs text-red-800">
                  {error}
                </p>
              ) : null}
            </div>
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={running}>
            Cancel
          </Button>
          <Button size="sm" onClick={onConfirm} disabled={running || eligible.length === 0}>
            {running ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
            {ACTION_LABEL[pending.action]} {eligible.length}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/*
 * Spec §9.5: "If a change can't be applied on the sending platform, the
 * dashboard says so with the actual reason, and does not show the change as
 * saved." A bulk action over 40 campaigns can half-succeed, so the result is
 * always itemised — and failures are listed first, because they're the only
 * part that needs a human.
 */
function ResultDialog({
  results,
  onClose,
}: {
  results: { action: CampaignAction; results: ActionResult[] } | null;
  onClose: () => void;
}) {
  if (!results) return null;
  const failures = results.results.filter((r) => !r.ok);
  const applied = results.results.length - failures.length;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {ACTION_LABEL[results.action]}: {applied} of {results.results.length} applied
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2">
              {failures.length ? (
                <ul className="max-h-60 space-y-1.5 overflow-y-auto rounded-md border border-red-300/60 bg-red-50/60 p-2 text-xs">
                  {failures.map((f) => (
                    <li key={f.campaignId}>
                      <span className="font-medium text-red-900">{f.name}</span>
                      <span className="block text-red-800">{f.error}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Every campaign was updated on EmailBison.
                </p>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
