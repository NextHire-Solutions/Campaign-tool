"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Search } from "lucide-react";
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
import { renderName } from "@/lib/campaigns/fan-out-name.ts";
import { cn } from "@/lib/utils";

/*
 * Build one campaign per client from this one.
 *
 * The preview line is the part that matters: it shows the ACTUAL name the first
 * selected client would get, rendered by the same function the server uses. A
 * template with a typo, or one that would produce identical names, is visible
 * before anything is created rather than after five campaigns exist.
 */

interface Summary {
  created: number;
  failed: number;
  targets: Array<{
    clientName: string;
    ok: boolean;
    campaignId: number | null;
    name: string;
    steps: number;
    inboxes: number;
    error?: string;
  }>;
}

export function FanOutDialog({
  campaignId,
  campaignName,
  open,
  onOpenChange,
}: {
  campaignId: number;
  campaignName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [template, setTemplate] = useState("");
  const [copyInboxes, setCopyInboxes] = useState(true);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data } = useQuery<{ clients: Array<{ id: string; name: string }> }>({
    queryKey: ["campaigns-clients-list"],
    queryFn: async () => {
      const response = await fetch("/api/campaigns?status=all&limit=1");
      if (!response.ok) throw new Error("Could not load clients");
      return response.json();
    },
    enabled: open,
    staleTime: 5 * 60_000,
  });

  const clients = data?.clients ?? [];
  const visible = search
    ? clients.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()))
    : clients;

  // Derived, not seeded, so it is correct however the dialog was opened.
  const effectiveTemplate = template || `{client} — ${campaignName}`;
  const firstChosen = clients.find((c) => chosen.has(c.id));
  const previewName = firstChosen ? renderName(effectiveTemplate, firstChosen.name) : "";

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/fan-out`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientIds: [...chosen],
          nameTemplate: effectiveTemplate,
          copyInboxes,
          confirm: true,
        }),
      });
      const body = await response.json();
      if (!response.ok && response.status !== 207) {
        setError(body.error ?? "Could not create the campaigns.");
        return;
      }
      setSummary(body as Summary);
      await queryClient.invalidateQueries({ queryKey: ["campaigns"] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the campaigns.");
    } finally {
      setRunning(false);
    }
  };

  const close = () => {
    onOpenChange(false);
    setTimeout(() => {
      setSummary(null);
      setError(null);
      setChosen(new Set());
    }, 200);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {summary ? "Campaigns created" : "Create for multiple clients"}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-3 pt-1 text-sm">
              {summary ? (
                <>
                  <p className="tnum">
                    <strong className="font-medium text-foreground">
                      {fullNumber(summary.created)}
                    </strong>{" "}
                    campaign{summary.created === 1 ? "" : "s"} created
                    {summary.failed ? `, ${fullNumber(summary.failed)} failed` : ""}.
                  </p>
                  <div className="max-h-56 space-y-0.5 overflow-auto rounded-md border p-2 text-xs">
                    {summary.targets.map((t) => (
                      <p key={t.clientName} className="flex items-baseline gap-2">
                        <span className={t.ok ? "text-emerald-700" : "text-red-700"}>
                          {t.ok ? "✓" : "✗"}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{t.name}</span>
                        <span className="tnum shrink-0 text-muted-foreground">
                          {t.ok ? `${t.steps} steps · ${fullNumber(t.inboxes)} inboxes` : t.error}
                        </span>
                      </p>
                    ))}
                  </div>
                  <div className="rounded-md border border-amber-300/60 bg-amber-50 p-2.5 text-xs text-amber-900">
                    <strong className="font-medium">They are drafts with no leads.</strong>{" "}
                    Add each client&rsquo;s leads, then start them from the Campaigns page.
                  </div>
                </>
              ) : (
                <>
                  <p>
                    Copies this campaign&rsquo;s sequence into a new campaign for each client
                    you pick, so the same setup does not have to be built by hand for each
                    one.
                  </p>

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-foreground" htmlFor="fo-name">
                      Name for each campaign
                    </label>
                    <Input
                      id="fo-name"
                      value={effectiveTemplate}
                      onChange={(e) => setTemplate(e.target.value)}
                      className="h-8 text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                      <code className="rounded bg-muted px-1">{"{client}"}</code> is replaced
                      with each client&rsquo;s name.
                      {previewName ? (
                        <>
                          {" "}
                          First one would be{" "}
                          <span className="font-medium text-foreground">{previewName}</span>.
                        </>
                      ) : null}
                    </p>
                  </div>

                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search clients…"
                      className="h-8 pl-8 text-sm"
                    />
                  </div>

                  <div className="max-h-56 space-y-0.5 overflow-auto rounded-md border p-1">
                    {visible.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() =>
                          setChosen((current) => {
                            const next = new Set(current);
                            if (next.has(c.id)) next.delete(c.id);
                            else next.add(c.id);
                            return next;
                          })
                        }
                        className={cn(
                          "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors",
                          chosen.has(c.id) ? "bg-accent font-medium" : "hover:bg-accent/50",
                        )}
                      >
                        <input
                          type="checkbox"
                          readOnly
                          checked={chosen.has(c.id)}
                          className="size-3.5 accent-foreground"
                        />
                        <span className="min-w-0 flex-1 truncate">{c.name}</span>
                      </button>
                    ))}
                  </div>

                  <label className="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={copyInboxes}
                      onChange={(e) => setCopyInboxes(e.target.checked)}
                      className="mt-0.5 size-3.5 accent-foreground"
                    />
                    <span>
                      Give each one the same inboxes as {campaignName}.
                    </span>
                  </label>

                  <div className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 p-2.5 text-xs text-amber-900">
                    <AlertTriangle className="mt-px size-3.5 shrink-0" />
                    <span>
                      {/*
                        Said plainly because it is the one thing someone might
                        assume otherwise: these clients have different audiences,
                        so copying the template's leads would mail one client's
                        list under another's name.
                      */}
                      Each campaign is created as a <strong className="font-medium">draft
                      with no leads</strong> — the sequence and inboxes are copied, the
                      audience is not. Add each client&rsquo;s own leads before starting them.
                    </span>
                  </div>
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
              <Button onClick={run} disabled={running || chosen.size === 0}>
                {running ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
                Create {chosen.size ? fullNumber(chosen.size) : ""} campaign
                {chosen.size === 1 ? "" : "s"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
