"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
 * Confirming the removal of leads from a campaign.
 *
 * This is the only destructive write in the product that cannot be undone:
 * pause has resume, and a sequence can be pushed again, but EmailBison offers
 * no "restore removed leads" call. Re-adding them is a separate deliberate act
 * against a list you would have to reconstruct yourself.
 *
 * So the dialog's job is to make the count real before the click, and to report
 * what actually happened after it — including the case where EmailBison accepts
 * fewer than were asked for, which it does silently.
 */

interface Result {
  ok: boolean;
  attempted: number;
  applied: number;
  skipped: number;
  chunks: Array<{ size: number; ok: boolean; message?: string; error?: string }>;
}

export function RemoveLeadsDialog({
  campaignId,
  campaignName,
  leadIds,
  open,
  onOpenChange,
  onDone,
}: {
  campaignId: number;
  campaignName: string;
  leadIds: number[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/leads/remove`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `confirm` is sent from here and nowhere else, so a mis-wired fetch
        // elsewhere in the app cannot empty a campaign.
        body: JSON.stringify({ leadIds, confirm: true }),
      });
      const body = await response.json();
      if (!response.ok && response.status !== 207) {
        setError(body.error ?? "The removal failed.");
        return;
      }
      setResult(body as Result);
      /*
       * Refetch rather than patch the cache: the row count, the status facets
       * and the paging all move together, and a hand-patched list would drift
       * from the server's idea of the page.
       */
      await queryClient.invalidateQueries({ queryKey: ["campaign-leads", campaignId] });
      await queryClient.invalidateQueries({ queryKey: ["campaign-lead-facets", campaignId] });
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The removal failed.");
    } finally {
      setRunning(false);
    }
  };

  const close = () => {
    onOpenChange(false);
    // Cleared on close, not on open, so the summary stays readable while the
    // dialog is being dismissed.
    setTimeout(() => {
      setResult(null);
      setError(null);
    }, 200);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {result ? "Removal finished" : `Remove ${fullNumber(leadIds.length)} leads?`}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-3 pt-1 text-sm">
              {result ? (
                <>
                  <p className="tnum">
                    <strong className="font-medium text-foreground">
                      {fullNumber(result.applied)}
                    </strong>{" "}
                    {result.applied === 1 ? "lead was" : "leads were"} removed from{" "}
                    {campaignName}.
                  </p>
                  {/*
                    Reported because EmailBison does not report it. It answers an
                    attach with success while silently dropping leads it will not
                    accept, and refuses a removal outright if an id is already
                    gone — so "asked for 500, removed 480" is a real outcome and
                    saying only "done" would be a lie of omission.
                  */}
                  {result.skipped > 0 ? (
                    <p className="tnum text-muted-foreground">
                      {fullNumber(result.skipped)} of the {fullNumber(result.attempted)}{" "}
                      selected {result.skipped === 1 ? "was" : "were"} already off this
                      campaign, so nothing changed for {result.skipped === 1 ? "it" : "them"}.
                    </p>
                  ) : null}
                  {result.chunks.some((c) => !c.ok) ? (
                    <div className="space-y-1 rounded-md border border-amber-300/60 bg-amber-50 p-2 text-xs text-amber-900">
                      <p className="font-medium">Some of it did not go through:</p>
                      {result.chunks
                        .filter((c) => !c.ok)
                        .slice(0, 3)
                        .map((c, i) => (
                          <p key={i}>
                            {fullNumber(c.size)} leads — {c.error}
                          </p>
                        ))}
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  <p>
                    This removes them from{" "}
                    <strong className="font-medium text-foreground">{campaignName}</strong>{" "}
                    in EmailBison. They stop receiving the rest of the sequence.
                  </p>
                  <div className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 p-2.5 text-xs text-amber-900">
                    <AlertTriangle className="mt-px size-3.5 shrink-0" />
                    <span>
                      {/*
                        Both halves matter. "Cannot be undone" is the warning;
                        "history is kept" stops someone believing this rewrites
                        the campaign's past and hesitating over the wrong risk.
                      */}
                      <strong className="font-medium">There is no undo.</strong> EmailBison
                      has no way to restore removed leads. Emails already sent are kept, so
                      this campaign&rsquo;s past numbers do not change — the leads simply
                      stop receiving anything further.
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    The leads themselves are not deleted, and stay in any other campaign
                    they belong to.
                  </p>
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
          {result ? (
            <Button onClick={close}>Close</Button>
          ) : (
            <>
              <Button variant="outline" onClick={close} disabled={running}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={run} disabled={running}>
                {running ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
                Remove {fullNumber(leadIds.length)}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
