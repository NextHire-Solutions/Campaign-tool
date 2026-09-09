"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { Input } from "@/components/ui/input";
import { fullNumber } from "@/lib/analytics/format.ts";

/*
 * Duplicate a campaign and load it with the people who never answered.
 *
 * The dialog's real job is the two numbers. "5,982 never replied" is the
 * interesting fact; "1,177 can actually be moved" is what will happen, and the
 * gap between them is not an error — it is everyone still being emailed by
 * another campaign, whom EmailBison rightly refuses to double-sequence.
 * Showing only one of the two either promises a move that will not happen or
 * makes it look like leads went missing.
 */

interface Preview {
  unresponsive: number;
  available: number;
  /** Bounced leads still attached to the source campaign. */
  bounced: number;
}

interface Result {
  ok: boolean;
  campaignId: number | null;
  name: string;
  steps: number;
  inboxes: number;
  leadsSelected: number;
  leadsAttached: number;
  leadsSkipped: number;
  bouncedRemoved: number;
  rolledBack?: boolean;
  error?: string;
}

export function ReCampaignDialog({
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
  // Empty means "not typed in yet"; the default is DERIVED during render
  // rather than seeded, so it is right however the dialog was opened. Seeding
  // it in an open handler broke the moment the caller set `open` directly,
  // leaving the name blank and the confirm button silently disabled.
  const [name, setName] = useState("");
  const [copyInboxes, setCopyInboxes] = useState(true);
  // Off by default: the only step here that changes the ORIGINAL campaign, and
  // EmailBison cannot put a removed lead back.
  const [removeBounced, setRemoveBounced] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: preview, isLoading } = useQuery<Preview>({
    queryKey: ["re-campaign-preview", campaignId],
    queryFn: async () => {
      const response = await fetch(`/api/campaigns/${campaignId}/re-campaign`);
      if (!response.ok) throw new Error("Could not count the leads");
      return response.json();
    },
    enabled: open,
    staleTime: 60_000,
  });

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/re-campaign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: effectiveName.trim(),
          copyInboxes,
          removeBouncedFromSource: removeBounced,
          confirm: true,
        }),
      });
      const body = await response.json();
      if (!response.ok && response.status !== 207) {
        setError(body.error ?? "Could not create the campaign.");
        if (body.campaignId) setResult(body as Result);
        return;
      }
      setResult(body as Result);
      await queryClient.invalidateQueries({ queryKey: ["campaigns"] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the campaign.");
    } finally {
      setRunning(false);
    }
  };

  const close = () => {
    onOpenChange(false);
    setTimeout(() => {
      setResult(null);
      setError(null);
    }, 200);
  };

  const effectiveName = name || `${campaignName} — follow-up`;
  const available = preview?.available ?? 0;
  const blocked = (preview?.unresponsive ?? 0) - available;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {result ? "Re-campaign finished" : "Duplicate & re-campaign"}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-3 pt-1 text-sm">
              {result ? (
                <>
                  {result.campaignId ? (
                    <>
                      <p className="tnum">
                        Created{" "}
                        <strong className="font-medium text-foreground">{result.name}</strong>{" "}
                        with {fullNumber(result.steps)} sequence step
                        {result.steps === 1 ? "" : "s"},{" "}
                        {fullNumber(result.inboxes)} inbox
                        {result.inboxes === 1 ? "" : "es"} and{" "}
                        <strong className="font-medium text-foreground">
                          {fullNumber(result.leadsAttached)}
                        </strong>{" "}
                        leads.
                      </p>
                      {result.bouncedRemoved > 0 ? (
                        <p className="tnum text-xs text-muted-foreground">
                          {fullNumber(result.bouncedRemoved)} bounced lead
                          {result.bouncedRemoved === 1 ? "" : "s"} removed from{" "}
                          {campaignName}.
                        </p>
                      ) : null}
                      {result.leadsSkipped > 0 ? (
                        <p className="tnum text-xs text-muted-foreground">
                          {fullNumber(result.leadsSkipped)} of the{" "}
                          {fullNumber(result.leadsSelected)} selected were refused — still
                          being emailed elsewhere, bounced, or unsubscribed.
                        </p>
                      ) : null}
                      <div className="rounded-md border border-amber-300/60 bg-amber-50 p-2.5 text-xs text-amber-900">
                        {/*
                          The most important line in the dialog. The campaign
                          exists and is loaded, and does nothing at all until
                          someone starts it — which is a separate decision this
                          feature deliberately does not make.
                        */}
                        <strong className="font-medium">
                          It is a draft and is not sending.
                        </strong>{" "}
                        Review the sequence and the leads, then start it from the Campaigns
                        page when you are ready.
                      </div>
                    </>
                  ) : (
                    <p>
                      {result.error}
                      {result.rolledBack ? (
                        <>
                          {" "}
                          <span className="text-muted-foreground">
                            The empty duplicate was deleted, so nothing was left behind.
                          </span>
                        </>
                      ) : null}
                    </p>
                  )}
                </>
              ) : (
                <>
                  <p>
                    Copies this campaign&rsquo;s sequence into a new campaign and adds the
                    leads who never replied, so they can be sequenced again.
                  </p>

                  {isLoading ? (
                    <p className="text-muted-foreground">Counting leads…</p>
                  ) : (
                    <div className="space-y-1 rounded-md border p-3">
                      <p className="tnum flex items-baseline justify-between">
                        <span>Never replied on this campaign</span>
                        <span className="font-medium text-foreground">
                          {fullNumber(preview?.unresponsive)}
                        </span>
                      </p>
                      <p className="tnum flex items-baseline justify-between text-muted-foreground">
                        <span>Still being emailed elsewhere</span>
                        <span>−{fullNumber(blocked)}</span>
                      </p>
                      <p className="tnum flex items-baseline justify-between border-t pt-1 font-medium">
                        <span>Can be moved</span>
                        <span>up to {fullNumber(available)}</span>
                      </p>
                    </div>
                  )}

                  {blocked > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {/*
                        Explained rather than just subtracted. This is EmailBison
                        protecting people from two sequences at once, not a
                        failure, and someone who does not know that will read the
                        smaller number as data loss.
                      */}
                      EmailBison will not add a lead who is part-way through another
                      campaign&rsquo;s sequence, so those are left out. The final count is
                      confirmed against EmailBison after the move.
                    </p>
                  ) : null}

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-foreground" htmlFor="rc-name">
                      New campaign name
                    </label>
                    <Input
                      id="rc-name"
                      value={effectiveName}
                      onChange={(e) => setName(e.target.value)}
                      className="h-8 text-sm"
                    />
                  </div>

                  <label className="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={copyInboxes}
                      onChange={(e) => setCopyInboxes(e.target.checked)}
                      className="mt-0.5 size-3.5 accent-foreground"
                    />
                    <span>
                      Use the same inboxes as {campaignName}.{" "}
                      <span className="text-muted-foreground">
                        A campaign with no inboxes cannot send.
                      </span>
                    </span>
                  </label>

                  {/*
                    Offered only when there is something to clean. A checkbox
                    that would do nothing is worse than no checkbox: it invites
                    a click and then reports zero.
                  */}
                  {(preview?.bounced ?? 0) > 0 ? (
                    <label className="flex items-start gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={removeBounced}
                        onChange={(e) => setRemoveBounced(e.target.checked)}
                        className="mt-0.5 size-3.5 accent-foreground"
                      />
                      <span className="tnum">
                        Also remove the{" "}
                        <strong className="font-medium text-foreground">
                          {fullNumber(preview?.bounced)} bounced
                        </strong>{" "}
                        lead{preview?.bounced === 1 ? "" : "s"} from {campaignName}.{" "}
                        <span className="text-muted-foreground">
                          They have already refused delivery and will refuse every
                          remaining step. This changes the original campaign and cannot
                          be undone.
                        </span>
                      </span>
                    </label>
                  ) : null}

                  <div className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 p-2.5 text-xs text-amber-900">
                    <AlertTriangle className="mt-px size-3.5 shrink-0" />
                    <span>
                      The new campaign is created as a <strong className="font-medium">draft</strong>{" "}
                      and sends nothing until you start it. The leads stay on {campaignName}{" "}
                      too — nothing is removed.
                    </span>
                  </div>
                </>
              )}
              {error && !result?.campaignId ? (
                <p className="rounded-md border border-red-300/60 bg-red-50 p-2 text-xs text-red-800">
                  {error}
                </p>
              ) : null}
            </div>
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          {result ? (
            <Button onClick={close}>Close</Button>
          ) : (
            <>
              <Button variant="outline" onClick={close} disabled={running}>
                Cancel
              </Button>
              <Button onClick={run} disabled={running || !effectiveName.trim() || available === 0}>
                {running ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
                Create draft{available ? ` · up to ${fullNumber(available)} leads` : ""}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
