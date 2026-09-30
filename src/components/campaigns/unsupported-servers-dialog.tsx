"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { fullNumber } from "@/lib/analytics/format.ts";

/*
 * Remove Unsupported Mail Servers (1 Oct). Opens with a count per server,
 * read from the platform at that moment; removing asks for confirmation,
 * finds the leads again on the server and counts again afterwards.
 */

interface Found { total: number; byServer: { server: string; count: number }[]; missing: string[] }
interface Removal extends Found { ok: boolean; removed: number; remaining: number; error?: string }

export function UnsupportedServersDialog({ campaignId, campaignName, platform, open, onOpenChange, onDone }: {
  campaignId: string;
  campaignName: string;
  platform: "emailbison" | "instantly";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [found, setFound] = useState<Found | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [armed, setArmed] = useState(false);
  const [result, setResult] = useState<Removal | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setFound(null); setError(null); setResult(null); setArmed(false);
    fetch(`/api/campaigns/${encodeURIComponent(campaignId)}/unsupported-servers`, { cache: "no-store" })
      .then(async (r) => { const b = await r.json().catch(() => null); if (!r.ok) throw new Error(b?.error ?? `HTTP ${r.status}`); return b as Found; })
      .then((b) => { if (live) setFound(b); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [open, campaignId]);

  async function run() {
    if (!armed) { setArmed(true); return; }
    setRunning(true); setError(null);
    try {
      const r = await fetch(`/api/campaigns/${encodeURIComponent(campaignId)}/unsupported-servers`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }),
      });
      const b = await r.json().catch(() => null);
      if (!r.ok && r.status !== 207) throw new Error(b?.error ?? `HTTP ${r.status}`);
      setResult(b as Removal);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  const close = () => { if (!running) onOpenChange(false); };
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Remove unsupported mail servers</DialogTitle>
          <DialogDescription>
            Leads on {campaignName} whose mail server is Proofpoint, Mimecast, Barracuda, Zoho or a custom server.
          </DialogDescription>
        </DialogHeader>

        {!found && !error ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Counting the campaign&apos;s leads by mail server…</p>
        ) : null}

        {found && !result ? (
          <div className="grid gap-3 text-sm">
            <table className="w-full">
              <tbody>
                {found.byServer.map((s) => (
                  <tr key={s.server} className="border-b"><td className="py-1.5">{s.server}</td><td className="tnum py-1.5 text-right">{fullNumber(s.count)}</td></tr>
                ))}
                <tr><td className="py-1.5 font-semibold">Total to remove</td><td className="tnum py-1.5 text-right font-semibold">{fullNumber(found.total)}</td></tr>
              </tbody>
            </table>
            {platform === "instantly" ? (
              <p className="rounded-md border border-amber-300/60 bg-amber-50 p-2 text-xs text-amber-900">
                Instantly reports Proofpoint, Mimecast, Barracuda and custom servers all as “other”, so they are removed together.
              </p>
            ) : null}
            {found.missing.length ? (
              <p className="rounded-md border border-amber-300/60 bg-amber-50 p-2 text-xs text-amber-900">Not found in EmailBison as a tag: {found.missing.join(", ")}.</p>
            ) : null}
            <p className="flex gap-2 rounded-md border border-amber-300/60 bg-amber-50 p-2 text-xs text-amber-900">
              <AlertTriangle className="size-4 shrink-0" />
              They are removed from this campaign only — the leads themselves are kept. This cannot be undone from here.
            </p>
          </div>
        ) : null}

        {result ? (
          <div className="grid gap-2 text-sm">
            <p className="tnum">Removed <strong>{fullNumber(result.removed)}</strong> lead{result.removed === 1 ? "" : "s"}.{result.remaining ? ` ${fullNumber(result.remaining)} are still on the campaign.` : " None are left."}</p>
            {result.error ? <p className="rounded-md border border-red-300/60 bg-red-50 p-2 text-xs text-red-800">{result.error}</p> : null}
          </div>
        ) : null}

        {error ? <p className="rounded-md border border-red-300/60 bg-red-50 p-2 text-xs text-red-800">{error}</p> : null}

        <DialogFooter>
          {result ? (
            <Button onClick={close}>Close</Button>
          ) : (
            <>
              <Button variant="outline" onClick={close} disabled={running}>Cancel</Button>
              <Button variant="destructive" onClick={run} disabled={running || !found || found.total === 0}>
                {running ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {armed ? `Remove ${found ? fullNumber(found.total) : ""} leads from this campaign?` : `Remove ${found ? fullNumber(found.total) : ""} leads`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
