"use client";

import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { compactNumber, fullNumber, percent } from "@/lib/analytics/format.ts";
import { SortableHeader } from "@/components/analytics/sortable-header";
import { useTableSort } from "@/hooks/use-table-sort";
import { cn } from "@/lib/utils";

/*
 * The Infrastructure tab (spec §8).
 *
 * Redesigned as a composition rather than a table with decoration: SUMMARY →
 * EXCEPTIONS → DETAIL. Earlier passes kept rearranging one long table, which is
 * why each one still read as a data dump.
 *
 * The change that gives the page a reason to exist is the distribution. A
 * headline of "bounce rate 1.80%" is an average over 150 sending domains, and
 * an average is precisely the number that cannot tell you whether you have a
 * broad problem or a short tail. The live shape is: 107 domains healthy, 41 in
 * the watch band carrying a THIRD of all volume, 2 critical. "Two domains are
 * bad" and "a third of your sending is drifting toward the line" are different
 * situations, and only the second one is true here.
 *
 * Surfaces are back. A previous pass stripped every border in the name of
 * cleanliness and the result read as unfinished — structure was doing real work
 * and removing it did not simplify the page, it flattened it. Cards on a tinted
 * page separate the three jobs; hairlines inside them separate rows.
 */

type View = "domain" | "provider" | "inbox";

/*
 * Cold-email thresholds. Sustained bounce above 3% is what gets a sending
 * domain reputation-flagged; 2% is worth watching before it becomes 3%.
 */
const WATCH = 0.02;
const HIGH = 0.03;
const METER_CEILING = 0.05;

/** Reserved status hues — never reused as series colours. */
const BAND = {
  ok: { fill: "#94a3b8", text: "text-foreground", name: "Healthy", note: `under ${percent(WATCH, 0)}` },
  watch: { fill: "#e0900f", text: "text-[#a16207]", name: "Watch", note: `${percent(WATCH, 0)}–${percent(HIGH, 0)}` },
  high: { fill: "#d03b3b", text: "text-[#b02525]", name: "Critical", note: `over ${percent(HIGH, 0)}` },
} as const;

type BandKey = keyof typeof BAND;

function bandOf(rate: number | null | undefined): BandKey | null {
  if (rate == null) return null;
  if (rate >= HIGH) return "high";
  if (rate >= WATCH) return "watch";
  return "ok";
}

/** `google_workspace_oauth` is a machine name, not something to read in a table. */
function providerLabel(provider: string | null): string {
  if (!provider) return "—";
  return (
    {
      google_workspace_oauth: "Google Workspace",
      microsoft_oauth: "Microsoft 365",
      custom: "Custom SMTP",
      smtp: "SMTP",
    }[provider] ?? provider.replace(/_/g, " ")
  );
}

interface Totals {
  inboxes: number; sending: number; domains: number; providers: number;
  sent: number; bounced: number; replied: number;
  bounce_rate: number | null; reply_rate: number | null;
}
interface InboxRow {
  id: number; email: string; name: string | null; domain: string | null;
  provider: string | null; status: string | null; daily_limit: number | null;
  sent: number; bounced: number; replied: number;
  bounce_rate: number | null; reply_rate: number | null;
}
interface GroupRow {
  label: string; inboxes: number; sent: number; bounced: number; replied: number;
  bounce_rate: number | null; reply_rate: number | null;
}
interface Band {
  band: BandKey; domains: number; inboxes: number; sent: number; bounced: number;
}
interface Response {
  view: View; totals: Totals | null;
  rows: Array<InboxRow | GroupRow>; total: number;
  problems: InboxRow[]; bands: Band[]; providers: GroupRow[]; minSent: number;
}

function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("rounded-xl border bg-card shadow-sm", className)}>{children}</div>
  );
}

/** Value + track, with the 3% line notched rather than merely implied. */
function Bounce({ rate }: { rate: number | null }) {
  const key = bandOf(rate);
  if (rate == null || !key) return <span className="text-muted-foreground">–</span>;
  const band = BAND[key];

  return (
    <span className="flex items-center justify-end gap-3">
      <span
        className="relative hidden h-1 w-24 shrink-0 overflow-hidden rounded-full bg-muted lg:block"
        aria-hidden
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${Math.min(rate / METER_CEILING, 1) * 100}%`,
            backgroundColor: band.fill,
          }}
        />
        <span
          className="absolute inset-y-0 w-px bg-foreground/25"
          style={{ left: `${(HIGH / METER_CEILING) * 100}%` }}
        />
      </span>
      <span className={cn("tnum w-14 text-right font-medium", band.text)}>
        {percent(rate, 2)}
      </span>
    </span>
  );
}

export function InfrastructureView() {
  const [view, setView] = useState<View>("domain");
  const [search, setSearch] = useState("");
  /*
   * Debounced, because the search is server-side. Without it every keystroke is
   * a query — "realty" alone would fire six, five of them already stale before
   * they returned. 250ms, matching the reply list and the leads table.
   */
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  /*
   * Server-side, because this list is paged — sorting the 100 rows the browser
   * holds out of 1,470 inboxes would look exactly like sorting the estate and
   * name the wrong worst inbox. p_sort/p_dir travel to the RPC.
   */
  const { sort, toggle } = useTableSort();

  const { data, isFetching } = useQuery<Response>({
    queryKey: ["infrastructure", view, debounced, sort?.key ?? "", sort?.dir ?? ""],
    queryFn: async () => {
      const params = new URLSearchParams({ view });
      if (sort) {
        params.set("sort", sort.key);
        params.set("dir", sort.dir);
      }
      if (debounced) params.set("q", debounced);
      const response = await fetch(`/api/infrastructure?${params}`);
      if (!response.ok) throw new Error("Could not load the sending estate");
      return response.json();
    },
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const totals = data?.totals;
  const problems = data?.problems ?? [];

  /*
   * Render from the shape the rows ACTUALLY have, not the toggle's state.
   * keepPreviousData holds the previous view's rows while the next load runs
   * and `view` flips instantly — reading a domain row as an inbox row crashed
   * the tab. The response echoes the view it was built for.
   */
  const rowsView = data?.view ?? view;
  const nameHeader = rowsView === "provider" ? "Provider" : "Domain";

  const bandBy = new Map((data?.bands ?? []).map((b) => [b.band, b]));
  const order: BandKey[] = ["ok", "watch", "high"];
  const bandRows = order.map((key) => ({ key, ...(bandBy.get(key) ?? null) }));
  const bandTotal = bandRows.reduce((sum, b) => sum + (b.domains ?? 0), 0);
  const volumeTotal = bandRows.reduce((sum, b) => sum + (b.sent ?? 0), 0);

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-muted/30">
      <div className="space-y-5 p-6">
        <header className="flex items-baseline gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Infrastructure</h1>
          {totals ? (
            <p className="tnum text-sm text-muted-foreground">
              {fullNumber(totals.sending)} of {fullNumber(totals.inboxes)} inboxes sending
            </p>
          ) : null}
          {isFetching ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          ) : null}
        </header>

        {/* ---- Summary: the health of the estate, and its shape ---- */}
        <div className="grid items-start gap-5 xl:grid-cols-[1.35fr_1fr]">
          <Card className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-6">
              <div>
                <p className="text-sm text-muted-foreground">Bounce rate</p>
                <p
                  className={cn(
                    "tnum mt-1 text-5xl font-semibold tracking-tight",
                    BAND[bandOf(totals?.bounce_rate) ?? "ok"].text,
                  )}
                >
                  {percent(totals?.bounce_rate, 2)}
                </p>
                <p className="tnum mt-2 text-sm text-muted-foreground">
                  {fullNumber(totals?.bounced)} bounced of {compactNumber(totals?.sent)} sent
                  {" · "}
                  {percent(HIGH, 0)} is the danger line
                </p>
              </div>

              <div className="text-right">
                <p className="text-sm text-muted-foreground">Reply rate</p>
                <p className="tnum mt-1 text-3xl font-semibold tracking-tight">
                  {percent(totals?.reply_rate, 2)}
                </p>
                <p className="tnum mt-2 text-sm text-muted-foreground">
                  {fullNumber(totals?.replied)} replies
                </p>
              </div>
            </div>

            {/*
              * Part-to-whole across three ordered bands: a stacked bar, split by
              * DOMAIN COUNT with the volume behind each band spelled out beneath.
              * Segments are separated by a 2px surface gap so adjacent fills
              * never touch.
              */}
            {bandTotal > 0 ? (
              <div className="mt-6">
                <div className="flex items-baseline justify-between">
                  <p className="text-sm font-medium">Sending domains by bounce band</p>
                  <p className="tnum text-sm text-muted-foreground">
                    {fullNumber(bandTotal)} sending · {fullNumber(totals?.domains)} total
                  </p>
                </div>

                <div className="mt-2.5 flex h-2.5 gap-0.5 overflow-hidden">
                  {bandRows
                    .filter((b) => (b.domains ?? 0) > 0)
                    .map((b) => (
                      <span
                        key={b.key}
                        className="h-full rounded-full"
                        style={{
                          width: `${((b.domains ?? 0) / bandTotal) * 100}%`,
                          backgroundColor: BAND[b.key].fill,
                        }}
                        aria-hidden
                      />
                    ))}
                </div>

                <dl className="mt-4 grid grid-cols-3 gap-4">
                  {bandRows.map((b) => (
                    <div key={b.key}>
                      <dt className="flex items-center gap-1.5 text-sm">
                        <span
                          className="size-2 shrink-0 rounded-full"
                          style={{ backgroundColor: BAND[b.key].fill }}
                          aria-hidden
                        />
                        <span className="font-medium">{BAND[b.key].name}</span>
                        <span className="text-muted-foreground">{BAND[b.key].note}</span>
                      </dt>
                      <dd className="tnum mt-1 pl-3.5">
                        <span className="text-lg font-semibold">{fullNumber(b.domains ?? 0)}</span>
                        <span className="ml-1.5 text-sm text-muted-foreground">
                          {(b.domains ?? 0) === 1 ? "domain" : "domains"}
                        </span>
                        {/*
                          * Share of VOLUME, not just count. 41 watch-band
                          * domains sounds minor until you see they carry a third
                          * of everything sent.
                          */}
                        <span className="mt-0.5 block text-sm text-muted-foreground">
                          {volumeTotal
                            ? `${percent((b.sent ?? 0) / volumeTotal, 0)} of volume`
                            : "—"}
                        </span>
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : null}

            {/*
              * The provider split lives in the summary rather than only behind a
              * tab: there are two of them, and "is one provider bouncing harder
              * than the other" is a question you answer at a glance or not at
              * all. It also gives this card the height to sit level with the
              * alert list beside it.
              */}
            {(data?.providers?.length ?? 0) > 0 ? (
              <div className="mt-6 border-t pt-4">
                <p className="text-sm font-medium">By provider</p>
                <table className="mt-2 w-full text-sm">
                  <tbody className="divide-y">
                    {data!.providers.map((p) => {
                      const key = bandOf(p.bounce_rate);
                      return (
                        <tr key={p.label}>
                          <td className="py-2 font-medium">{providerLabel(p.label)}</td>
                          <td className="tnum py-2 text-right text-muted-foreground">
                            {fullNumber(p.inboxes)} inboxes
                          </td>
                          <td className="tnum py-2 text-right">{compactNumber(p.sent)} sent</td>
                          <td className="py-2 pl-4 text-right">
                            <span
                              className={cn(
                                "tnum font-medium",
                                key ? BAND[key].text : "",
                              )}
                            >
                              {percent(p.bounce_rate, 2)}
                            </span>
                            <span className="ml-1 text-muted-foreground">bounce</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}
          </Card>

          {/* ---- Exceptions: the only part of this page you act on ---- */}
          <Card className="flex min-h-0 flex-col">
            <div className="flex items-baseline justify-between border-b px-5 py-4">
              <h2 className="text-sm font-medium">Needs attention</h2>
              <p className="text-sm text-muted-foreground">
                worst bounce, {data?.minSent}+ sends
              </p>
            </div>

            {problems.length ? (
              <ul className="divide-y">
                {problems.slice(0, 8).map((row) => {
                  const key = bandOf(row.bounce_rate);
                  return (
                    <li
                      key={row.id}
                      className="flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-muted/50"
                    >
                      <span className="min-w-0 flex-1">
                        <span
                          className="block truncate text-sm font-medium"
                          title={row.domain ?? ""}
                        >
                          {row.domain ?? "—"}
                        </span>
                        <span className="tnum block truncate text-xs text-muted-foreground">
                          {row.email?.split("@")[0] ?? "—"} · {fullNumber(row.bounced)} of{" "}
                          {fullNumber(row.sent)}
                        </span>
                      </span>
                      <span
                        className={cn(
                          "tnum shrink-0 text-sm font-semibold",
                          key ? BAND[key].text : "",
                        )}
                      >
                        {percent(row.bounce_rate, 2)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-5 py-8 text-center text-sm text-muted-foreground">
                No inbox is above the threshold.
              </p>
            )}
          </Card>
        </div>

        {/* ---- Detail: the full estate ---- */}
        <Card>
          <div className="flex flex-wrap items-center gap-2 border-b p-4">
            <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5">
              {(
                [
                  ["domain", "Domain"],
                  ["provider", "Provider"],
                  ["inbox", "Inbox"],
                ] as const
              ).map(([key, text]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setView(key)}
                  className={cn(
                    "rounded-md px-3 py-1 text-sm transition-colors",
                    view === key
                      ? "bg-background font-medium text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {text}
                </button>
              ))}
            </div>

                        {/* Every view is searchable now. Domain and provider had 503 and 2
                rows respectively with no way to filter them. */}
            <div className="relative min-w-[200px] max-w-xs flex-1">
              <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={
                  view === "inbox" ? "Search inbox or domain…" : "Search domain, inbox or provider…"
                }
                className="h-9 rounded-lg pl-9 text-sm"
              />
            </div>

            <p className="tnum ml-auto text-sm text-muted-foreground">
              {rowsView === "inbox"
                ? `${fullNumber(data?.total ?? 0)} inboxes`
                : `${fullNumber(data?.rows.length ?? 0)} ${rowsView === "domain" ? "domains" : "providers"}`}
            </p>
          </div>

          {/*
            * table-fixed: with `auto` the browser hands every spare pixel to the
            * widest text column, so the name ran to ~1100px while its numbers
            * huddled at the far right. Fixed shares spread the slack evenly.
            */}
          <table className="w-full table-fixed text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                {rowsView === "inbox" ? (
                  <>
                    <SortableHeader label={nameHeader} sortKey="domain" align="left" sort={sort} onToggle={toggle} className="w-[24%] px-5 py-2.5" />
                    <SortableHeader label="Mailbox" sortKey="email" align="left" sort={sort} onToggle={toggle} className="w-[13%] py-2.5" />
                    <SortableHeader label="Provider" sortKey="provider" align="left" sort={sort} onToggle={toggle} className="w-[14%] py-2.5" />
                  </>
                ) : (
                  <>
                    {/* The domain and provider rollups had no sort control at
                        all — the dropdown was rendered only on the inbox view. */}
                    <SortableHeader label={nameHeader} sortKey="label" align="left" sort={sort} onToggle={toggle} className="w-[25%] px-5 py-2.5" />
                    <SortableHeader label="Inboxes" sortKey="inboxes" sort={sort} onToggle={toggle} className="w-[11%] py-2.5" />
                  </>
                )}
                <SortableHeader label="Sent" sortKey="sent" sort={sort} onToggle={toggle} className="w-[12%] py-2.5" />
                <SortableHeader label="Bounced" sortKey="bounced" sort={sort} onToggle={toggle} className="w-[12%] py-2.5" />
                <SortableHeader label={<>Reply&nbsp;%</>} sortKey="reply_rate" sort={sort} onToggle={toggle} className="w-[12%] py-2.5" />
                <SortableHeader label="Bounce rate" sortKey="bounce_rate" sort={sort} onToggle={toggle} className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {!data?.rows.length ? (
                <tr>
                  <td colSpan={7} className="py-16 text-center text-muted-foreground">
                    Nothing to show. Run sync-senders if this is unexpected.
                  </td>
                </tr>
              ) : (
                data.rows.map((row, i) => {
                  const inbox = rowsView === "inbox" ? (row as InboxRow) : null;
                  const group = inbox ? null : (row as GroupRow);
                  return (
                    <tr
                      key={inbox?.id ?? group?.label ?? i}
                      className="transition-colors hover:bg-muted/50"
                    >
                      {inbox ? (
                        <>
                          <td
                            className="truncate px-5 py-2.5 font-medium"
                            title={inbox.domain ?? ""}
                          >
                            {inbox.domain ?? "—"}
                          </td>
                          <td className="truncate px-3 py-2.5 text-muted-foreground">
                            {inbox.email?.split("@")[0] ?? "—"}
                          </td>
                          <td className="truncate px-3 py-2.5 text-muted-foreground">
                            {providerLabel(inbox.provider)}
                            {/* Status only when it is NOT the norm — 1,470 rows
                                reading "Connected" is not information. */}
                            {inbox.status && inbox.status !== "Connected" ? (
                              <span className="ml-1.5 rounded bg-amber-100 px-1 text-xs text-amber-900">
                                {inbox.status}
                              </span>
                            ) : null}
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="truncate px-5 py-2.5 font-medium" title={group!.label}>
                            {rowsView === "provider"
                              ? providerLabel(group!.label)
                              : group!.label}
                          </td>
                          <td className="tnum px-3 py-2.5 text-right text-muted-foreground">
                            {fullNumber(group!.inboxes)}
                          </td>
                        </>
                      )}
                      <td className="tnum px-3 py-2.5 text-right">{fullNumber(row.sent)}</td>
                      <td className="tnum px-3 py-2.5 text-right text-muted-foreground">
                        {fullNumber(row.bounced)}
                      </td>
                      <td className="tnum px-3 py-2.5 text-right text-muted-foreground">
                        {percent(row.reply_rate, 2)}
                      </td>
                      <td className="px-5 py-2.5">
                        <Bounce rate={row.bounce_rate} />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </Card>

        <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
          <strong className="font-medium text-foreground">Lifetime figures.</strong> These do not
          respond to the date range above — EmailBison reports per-inbox performance only as
          running totals. They also will not match the campaign totals in Analytics exactly:
          warm-up sends and inboxes attached to deleted campaigns count here but not there.
        </p>
      </div>
    </div>
  );
}
