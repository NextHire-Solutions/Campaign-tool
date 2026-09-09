"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Inbox, Loader2, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fullNumber } from "@/lib/analytics/format.ts";
import { cn } from "@/lib/utils";

/*
 * Assigning a tagged pool of inboxes to the selected campaigns.
 *
 * The tags are EmailBison's own — "Nicole Pool", "LeadGenJay", "Zapmail" — read
 * from our cache of every inbox, so choosing a pool costs no API calls and a
 * pool created upstream appears after the next sync-senders.
 */

interface TagRow {
  tag: string;
  inboxes: number;
  connected: number;
}

interface Summary {
  tag: string;
  action: "attach" | "remove";
  inboxes: number;
  skippedDisconnected: number;
  results: Array<{
    campaignId: number;
    name: string;
    ok: boolean;
    applied: number;
    alreadyAttached?: number;
    error?: string;
  }>;
}

interface AssignedInbox {
  id: number;
  email: string;
  status: string | null;
  vendor: string | null;
  dailyLimit: number | null;
}
interface Assigned {
  total: number;
  connected: number;
  tags: Array<{ tag: string; inboxes: number }>;
  /** The actual mailboxes on this campaign, broken ones first. */
  inboxes: AssignedInbox[];
}

export function AssignInboxesDialog({
  campaignIds,
  open,
  onOpenChange,
  onDone,
}: {
  campaignIds: number[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [tag, setTag] = useState<string>("");
  const [action, setAction] = useState<"attach" | "remove">("attach");
  /*
   * A third view, because counts and a list answer different questions. "Nicole
   * Pool 346" tells you the right pool is on the campaign; it does not tell you
   * WHICH mailboxes are sending for it, which is what was actually asked for
   * and the only way to spot a specific broken inbox.
   */
  const [showing, setShowing] = useState<"pools" | "assigned">("pools");
  const [assignedSearch, setAssignedSearch] = useState("");
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<{ tags: TagRow[] }>({
    queryKey: ["inbox-tags"],
    queryFn: async () => {
      const response = await fetch("/api/campaigns/inboxes");
      if (!response.ok) throw new Error("Could not load inbox tags");
      return response.json();
    },
    enabled: open,
    staleTime: 5 * 60_000,
  });

  /*
   * What is ALREADY on the campaign, for the single-campaign case.
   *
   * Client feedback: the dialog offered pools to attach without saying what was
   * there, so an addition and a no-op looked identical, and a campaign sending
   * from the wrong pool looked like every other campaign. Only fetched for one
   * campaign — across a bulk selection there is no single answer, and showing
   * the first one's inboxes would be worse than showing none.
   */
  const { data: assigned } = useQuery<Assigned>({
    queryKey: ["campaign-inboxes", campaignIds[0]],
    queryFn: async () => {
      const response = await fetch(`/api/campaigns/${campaignIds[0]}/inboxes`);
      if (!response.ok) throw new Error("Could not read the current inboxes");
      return response.json();
    },
    enabled: open && campaignIds.length === 1,
    staleTime: 60_000,
  });

  const tags = data?.tags ?? [];
  const alreadyOn = new Map((assigned?.tags ?? []).map((t) => [t.tag, t.inboxes]));
  const chosen = tags.find((t) => t.tag === tag);
  // What will actually be sent: an attach skips inboxes that cannot send.
  const willSend = chosen ? (action === "attach" ? chosen.connected : chosen.inboxes) : 0;
  const dead = chosen ? chosen.inboxes - chosen.connected : 0;

  /*
   * How many of this pool are ALREADY on the campaign, and therefore how many
   * would genuinely change.
   *
   * The warning used to read "531 inboxes will start sending" when 346 of them
   * were already sending — true of the end state, false about the change, and
   * the number a reader takes away is the change. Only meaningful for a single
   * campaign; across a bulk selection each one has its own overlap and there is
   * no single figure.
   */
  const single = campaignIds.length === 1;
  const onAlready = single ? Math.min(alreadyOn.get(tag) ?? 0, willSend) : 0;
  const newlyAdded = Math.max(willSend - onAlready, 0);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const response = await fetch("/api/campaigns/inboxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignIds, tag, action, confirm: true }),
      });
      const body = await response.json();
      if (!response.ok && response.status !== 207) {
        setError(body.error ?? "The assignment failed.");
        return;
      }
      setSummary(body as Summary);
      await queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The assignment failed.");
    } finally {
      setRunning(false);
    }
  };

  const close = () => {
    onOpenChange(false);
    setTimeout(() => {
      setSummary(null);
      setError(null);
    }, 200);
  };

  const failed = summary?.results.filter((r) => !r.ok) ?? [];

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {summary
              ? "Assignment finished"
              : `${action === "attach" ? "Assign" : "Remove"} inboxes · ${fullNumber(campaignIds.length)} campaign${campaignIds.length === 1 ? "" : "s"}`}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-3 pt-1 text-sm">
              {summary ? (
                <>
                  <p className="tnum">
                    <strong className="font-medium text-foreground">
                      {fullNumber(summary.inboxes)}
                    </strong>{" "}
                    inboxes tagged <strong className="font-medium text-foreground">{summary.tag}</strong>{" "}
                    {summary.action === "attach" ? "assigned to" : "removed from"}{" "}
                    {fullNumber(summary.results.filter((r) => r.ok).length)} of{" "}
                    {fullNumber(summary.results.length)} campaigns.
                  </p>
                  {summary.skippedDisconnected > 0 ? (
                    <p className="tnum text-xs text-muted-foreground">
                      {fullNumber(summary.skippedDisconnected)} tagged{" "}
                      {summary.skippedDisconnected === 1 ? "inbox is" : "inboxes are"} not
                      connected and {summary.skippedDisconnected === 1 ? "was" : "were"} left
                      out — they cannot send.
                    </p>
                  ) : null}
                  {failed.length ? (
                    <div className="max-h-40 space-y-1 overflow-auto rounded-md border border-amber-300/60 bg-amber-50 p-2 text-xs text-amber-900">
                      <p className="font-medium">{failed.length} did not go through:</p>
                      {failed.slice(0, 6).map((r) => (
                        <p key={r.campaignId} className="truncate">
                          {r.name} — {r.error}
                        </p>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5">
                    {(["attach", "remove"] as const).map((key) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => { setAction(key); setShowing("pools"); }}
                        className={cn(
                          "flex-1 rounded-md px-3 py-1 text-sm transition-colors",
                          action === key
                            ? "bg-background font-medium text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {key === "attach" ? "Assign to campaigns" : "Remove from campaigns"}
                      </button>
                    ))}
                  </div>

                  {campaignIds.length === 1 && assigned ? (
                    <div className="rounded-md border bg-muted/30 p-2.5 text-xs">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <p className="tnum">
                          <strong className="font-medium text-foreground">
                            {fullNumber(assigned.total)}
                          </strong>{" "}
                          inbox{assigned.total === 1 ? "" : "es"} currently assigned
                          {assigned.connected !== assigned.total ? (
                            <span className="text-[#b02525]">
                              {" "}
                              · {fullNumber(assigned.total - assigned.connected)} of them cannot
                              connect
                            </span>
                          ) : null}
                        </p>
                        <button
                          type="button"
                          onClick={() =>
                            setShowing(showing === "assigned" ? "pools" : "assigned")
                          }
                          className="shrink-0 underline underline-offset-2 hover:text-foreground"
                        >
                          {showing === "assigned" ? "Back to pools" : "See which ones"}
                        </button>
                      </div>
                      {assigned.tags.length && showing === "pools" ? (
                        <p className="tnum mt-1 text-muted-foreground">
                          {assigned.tags
                            .slice(0, 4)
                            .map((t) => `${t.tag} ${fullNumber(t.inboxes)}`)
                            .join(" · ")}
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  {/* The mailboxes themselves. */}
                  {showing === "assigned" && assigned ? (
                    <>
                      <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          value={assignedSearch}
                          onChange={(e) => setAssignedSearch(e.target.value)}
                          placeholder="Search assigned inboxes…"
                          className="h-8 pl-8 text-sm"
                        />
                      </div>
                      <div className="max-h-72 divide-y overflow-auto rounded-md border">
                        {(() => {
                          const q = assignedSearch.trim().toLowerCase();
                          const list = q
                            ? assigned.inboxes.filter(
                                (i) =>
                                  i.email?.toLowerCase().includes(q) ||
                                  (i.vendor ?? "").toLowerCase().includes(q),
                              )
                            : assigned.inboxes;
                          if (!list.length) {
                            return (
                              <p className="px-2.5 py-6 text-center text-xs text-muted-foreground">
                                No assigned inbox matches that.
                              </p>
                            );
                          }
                          return list.map((i) => (
                            <p
                              key={i.id}
                              className="flex items-center gap-2 px-2.5 py-1.5 text-xs"
                            >
                              <span className="min-w-0 flex-1 truncate" title={i.email}>
                                {i.email}
                              </span>
                              <span className="shrink-0 text-muted-foreground">
                                {i.vendor ?? "Untagged"}
                              </span>
                              {/*
                                Status shown only when it is NOT the norm — 641
                                rows reading "Connected" is not information, and
                                the broken ones are sorted to the top so they
                                are the first thing in view.
                              */}
                              {i.status && i.status !== "Connected" ? (
                                <span className="shrink-0 rounded bg-[#fdecec] px-1 text-[10px] font-medium text-[#b02525]">
                                  {i.status}
                                </span>
                              ) : null}
                            </p>
                          ));
                        })()}
                      </div>
                    </>
                  ) : null}

                  {showing === "pools" && isLoading ? (
                    <p className="text-muted-foreground">Loading inbox tags…</p>
                  ) : showing === "assigned" ? null : (
                    <div className="max-h-64 space-y-0.5 overflow-auto rounded-md border p-1">
                      {tags.map((t) => (
                        <button
                          key={t.tag}
                          type="button"
                          onClick={() => setTag(t.tag)}
                          className={cn(
                            "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors",
                            tag === t.tag ? "bg-accent font-medium" : "hover:bg-accent/50",
                          )}
                        >
                          <Inbox className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate">{t.tag}</span>
                          {/*
                            Says how much of this pool is ALREADY on the campaign,
                            so "assign" and "re-assign what is already there" are
                            distinguishable before the click rather than after.
                          */}
                          {alreadyOn.has(t.tag) ? (
                            <span className="tnum shrink-0 rounded bg-emerald-100 px-1 text-[10px] font-medium text-emerald-800">
                              {fullNumber(alreadyOn.get(t.tag))} on
                            </span>
                          ) : null}
                          {/*
                            Both numbers, because they answer different questions:
                            the pool you have, and the part of it that can send.
                          */}
                          <span className="tnum shrink-0 text-xs text-muted-foreground">
                            {fullNumber(t.connected)}
                            {t.connected !== t.inboxes ? ` of ${fullNumber(t.inboxes)}` : ""}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}

                  {chosen && showing === "pools" ? (
                    <div className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 p-2.5 text-xs text-amber-900">
                      <AlertTriangle className="mt-px size-3.5 shrink-0" />
                      <span className="tnum">
                        {action === "attach" ? (
                          <>
                            {single && newlyAdded === 0 && onAlready > 0 ? (
                              <>
                                {/*
                                  Nothing to do. The attach would succeed and
                                  change nothing, and a button reading "Assign 0"
                                  invites a click that reports success for a
                                  no-op.
                                */}
                                All {fullNumber(onAlready)} connected{" "}
                                {chosen?.tag} inboxes are already on this campaign.
                                Nothing to add.
                              </>
                            ) : single && onAlready > 0 ? (
                              <>
                                <strong className="font-medium">
                                  {fullNumber(newlyAdded)}{" "}
                                  {newlyAdded === 1 ? "inbox" : "inboxes"}
                                </strong>{" "}
                                will start sending.{" "}
                                {fullNumber(onAlready)} of this pool{" "}
                                {onAlready === 1 ? "is" : "are"} already on the campaign, so
                                it will hold {fullNumber(willSend)} from{" "}
                                {chosen?.tag} afterwards.
                              </>
                            ) : (
                              <>
                                <strong className="font-medium">
                                  {fullNumber(willSend)} inboxes
                                </strong>{" "}
                                will start sending for {fullNumber(campaignIds.length)}{" "}
                                campaign{campaignIds.length === 1 ? "" : "s"}.
                              </>
                            )}
                            {dead > 0 ? (
                              <>
                                {" "}
                                {fullNumber(dead)} tagged{" "}
                                {dead === 1 ? "inbox is" : "inboxes are"} not connected and
                                will be left out.
                              </>
                            ) : null}
                          </>
                        ) : (
                          <>
                            <strong className="font-medium">
                              {fullNumber(willSend)} inboxes
                            </strong>{" "}
                            will stop sending for {fullNumber(campaignIds.length)}{" "}
                            campaign{campaignIds.length === 1 ? "" : "s"}. A campaign left
                            with no inboxes cannot send at all.
                          </>
                        )}
                      </span>
                    </div>
                  ) : null}
                </>
              )}
              {error ? (
                <p className="rounded-md border border-red-300/60 bg-red-50 p-2 text-xs text-red-800">
                  {error}
                </p>
              ) : null}
            </div>
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          {summary ? (
            <Button onClick={close}>Close</Button>
          ) : (
            <>
              <Button variant="outline" onClick={close} disabled={running}>
                Cancel
              </Button>
              <Button
                onClick={run}
                disabled={
                  running ||
                  !tag ||
                  willSend === 0 ||
                  // Nothing would change: every connected inbox in this pool is
                  // already on the campaign.
                  (action === "attach" && single && newlyAdded === 0)
                }
              >
                {running ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
                {action === "attach" ? "Assign" : "Remove"}
                {chosen
                  ? ` ${fullNumber(action === "attach" && single && onAlready > 0 ? newlyAdded : willSend)}`
                  : ""}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
