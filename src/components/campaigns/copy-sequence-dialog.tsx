"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { platformOfId } from "@/lib/campaigns/campaign-id.ts";

/*
 * Copy a sequence into this campaign (spec §9.4).
 *
 * "Written as a guided flow, because replacing a live campaign's emails is the
 * most consequential thing you can do here."
 *
 * Three steps, in the spec's order: pick the source, choose how, review exactly
 * what will happen. The review step is not a summary — it lists the steps being
 * created AND, for Replace, the ones being destroyed, because EmailBison has no
 * atomic replace and no undo.
 */

type Mode = "replace" | "append";

interface PlanStep {
  order: number;
  subject: string | null;
  waitInDays: number | null;
  threadReply: boolean;
  isVariant: boolean;
  opening: string | null;
}

interface Plan {
  sourceName: string;
  targetName: string;
  targetStatus: string;
  mode: Mode;
  steps: PlanStep[];
  removing: PlanStep[];
  /** Replace cannot proceed — a target step has already sent emails. */
  blocked: boolean;
  warnings: string[];
}

interface CampaignOption {
  /*
   * A STRING over the wire. /api/campaigns reads the cross-platform
   * `campaigns_unified` view, whose id column is text so an EmailBison bigint
   * and an Instantly uuid can share it — so even EmailBison campaigns arrive
   * as "297". Typing it `number` here was a lie TypeScript could not catch,
   * because it comes from response.json(). The route requires a number, so
   * every copy failed validation with "Invalid request" while the dialog
   * still displayed the source name (its lookup compares string to string).
   * Normalised to a number in `options` below, once, at the boundary.
   */
  id: number | string;
  name: string;
  status: string;
  platform?: string;
}

export function CopySequenceDialog({
  targetId,
  targetName,
  open,
  onOpenChange,
}: {
  targetId: number | string;
  targetName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [stage, setStage] = useState<"pick" | "options" | "review">("pick");
  const [search, setSearch] = useState("");
  const [sourceId, setSourceId] = useState<string | number | null>(null);
  const [mode, setMode] = useState<Mode>("append");
  const [includeVariants, setIncludeVariants] = useState(true);
  const [includeAttachments, setIncludeAttachments] = useState(true);
  /*
   * §9.4 lists copy tags alongside variants and attachments. Defaults on: a
   * sequence copied without its dimensions shows as Untagged in Copy & Offer —
   * dropping out of the analysis that identified it as worth copying.
   */
  const [includeCopyTags, setIncludeCopyTags] = useState(true);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [typed, setTyped] = useState("");

  const targetPlatform = platformOfId(String(targetId)) ?? "emailbison";

  const { data: list } = useQuery<{ items: CampaignOption[] }>({
    queryKey: ["campaigns", "copy-source", targetPlatform, search],
    queryFn: async () => {
      /*
       * Ask for this platform's campaigns only, and for all of them.
       *
       * The default page is 200 ordered by lifetime sends, which quietly hid
       * every low-volume campaign: a freshly created one has sent nothing, so
       * it sorted last and fell off the end. The picker then showed no
       * campaigns at all on a workspace that had them.
       */
      const params = new URLSearchParams({
        status: "all",
        platforms: targetPlatform,
        limit: "500",
      });
      if (search) params.set("q", search);
      const response = await fetch(`/api/campaigns?${params}`);
      if (!response.ok) throw new Error("Failed to load campaigns");
      return response.json();
    },
    enabled: open,
    staleTime: 60_000,
  });

  /*
   * Sources must be on the SAME platform as the target. A sequence is copied
   * verbatim and the two platforms do not write copy the same way —
   * EmailBison merges {FIRST_NAME} and spins {Hi|Hello}, Instantly merges
   * {{firstName}} and spins {{RANDOM |Hi|Hello}} — so a cross-platform copy
   * would arrive broken. The server refuses one; this stops it being offered.
   *
   * The platform comes from the target id's own shape: EmailBison keys with a
   * bigint, Instantly with a uuid, so the two cannot be confused.
   */
  const options: CampaignOption[] = (list?.items ?? [])
    .filter((c) => (c.platform ?? "emailbison") === targetPlatform)
    // a campaign cannot be its own source
    .filter((c) => String(c.id) !== String(targetId));
  const source = options.find((c) => String(c.id) === String(sourceId));

  const preview = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/campaigns/${targetId}/copy-sequence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceCampaignId: sourceId,
          mode,
          includeVariants,
          includeAttachments,
          includeCopyTags,
          apply: false,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not build the preview");
      return body.plan as Plan;
    },
    onSuccess: (result) => {
      setPlan(result);
      setStage("review");
    },
  });

  const commit = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/campaigns/${targetId}/copy-sequence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceCampaignId: sourceId,
          mode,
          includeVariants,
          includeAttachments,
          includeCopyTags,
          apply: true,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(
          body.targetLeftEmpty
            ? `${body.error}\n\nThis campaign now has NO sequence. Its previous steps are preserved in the Activity tab.`
            : (body.error ?? "The copy could not be applied"),
        );
      }
      return body;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaign", targetId] });
      close();
    },
  });

  function close() {
    onOpenChange(false);
    // Reset so reopening starts the guided flow from the beginning rather than
    // on a stale review of a plan built from different options.
    setStage("pick");
    setSourceId(null);
    setPlan(null);
    setTyped("");
    setSearch("");
    preview.reset();
    commit.reset();
  }

  /*
   * Replace destroys emails with no undo, so it asks for the campaign name to
   * be typed. Append only adds, so it doesn't — an unskippable ritual on the
   * safe path is how people learn to type past the dangerous one too.
   */
  const needsTyped = mode === "replace" && (plan?.removing.length ?? 0) > 0;
  const confirmed = !needsTyped || typed.trim() === targetName.trim();
  /*
   * Disabled, not just warned. EmailBison refuses to delete a step that has
   * sent, so Replace here would delete what it can, fail on the first step with
   * volume, and leave a half-dismantled sequence. Better to not offer it.
   */
  const blockedByVolume = Boolean(plan?.blocked);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      {/* min-w-0 is load-bearing: DialogContent is a grid, and a grid item
          defaults to min-width:auto, so one long campaign name pushed the list
          and the footer clean outside the dialog. */}
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Copy a sequence into &ldquo;{targetName}&rdquo;
          </DialogTitle>
        </DialogHeader>

        {stage === "pick" ? (
          <div className="min-w-0 space-y-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search campaigns to copy from…"
                className="h-8 pl-8 text-xs"
              />
            </div>
            <div className="max-h-72 min-w-0 space-y-0.5 overflow-hidden overflow-y-auto rounded-md border p-1">
              {options.length === 0 ? (
                <p className="p-4 text-center text-xs text-muted-foreground">
                  No campaigns match
                </p>
              ) : (
                options.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setSourceId(c.id)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent",
                      String(sourceId) === String(c.id) && "bg-accent",
                    )}
                  >
                    <span className="flex size-3.5 shrink-0 items-center justify-center rounded-full border">
                      {String(sourceId) === String(c.id) ? <Check className="size-2.5" /> : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{c.name}</span>
                    <span className="shrink-0 text-muted-foreground">{c.status}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : null}

        {stage === "options" ? (
          <div className="min-w-0 space-y-4 text-sm">
            <p className="text-xs text-muted-foreground">
              Copying from <strong className="text-foreground">{source?.name}</strong>
            </p>

            <div className="space-y-2">
              {(
                [
                  ["append", "Append", "Add these steps after the campaign's existing sequence."],
                  [
                    "replace",
                    "Replace",
                    "Delete the existing sequence first. EmailBison has no undo — the old steps are recorded in Activity before anything is removed.",
                  ],
                ] as const
              ).map(([value, label, hint]) => (
                <label
                  key={value}
                  className={cn(
                    "flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5",
                    mode === value && "border-foreground/40 bg-accent/40",
                    value === "replace" && mode === "replace" && "border-amber-400 bg-amber-50",
                  )}
                >
                  <input
                    type="radio"
                    name="mode"
                    checked={mode === value}
                    onChange={() => {
                      setMode(value);
                      // Clear the previous mode's failure. Otherwise a Replace
                      // error ("cannot be deleted…") sits under an Append,
                      // which deletes nothing.
                      preview.reset();
                      commit.reset();
                    }}
                    className="mt-0.5 accent-foreground"
                  />
                  <span>
                    <span className="block text-xs font-medium">{label}</span>
                    <span className="block text-[11px] text-muted-foreground">{hint}</span>
                  </span>
                </label>
              ))}
            </div>

            <div className="space-y-2 border-t pt-3">
              {(
                [
                  [includeVariants, setIncludeVariants, "Bring variants"],
                  [includeAttachments, setIncludeAttachments, "Bring attachments"],
                  [includeCopyTags, setIncludeCopyTags, "Bring copy tags"],
                ] as const
              ).map(([value, set, label]) => (
                <label key={label} className="flex cursor-pointer items-center gap-2.5">
                  <input
                    type="checkbox"
                    checked={value}
                    onChange={(e) => set(e.target.checked)}
                    className="size-3.5 accent-foreground"
                  />
                  <span className="text-xs">{label}</span>
                </label>
              ))}
            </div>

            {preview.error ? (
              <p className="rounded-md border border-red-300/60 bg-red-50 p-2 text-xs text-red-800">
                {preview.error.message}
              </p>
            ) : null}
          </div>
        ) : null}

        {stage === "review" && plan ? (
          <div className="min-w-0 space-y-3 text-sm">
            {plan.warnings.map((warning, i) => (
              <p
                key={i}
                className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 p-2.5 text-xs text-amber-900"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>{warning}</span>
              </p>
            ))}

            {plan.removing.length ? (
              <div>
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-red-800">
                  Will be deleted ({plan.removing.length})
                </p>
                <ul className="max-h-28 space-y-1 overflow-y-auto rounded-md border border-red-300/60 bg-red-50/50 p-2 text-xs">
                  {plan.removing.map((step, i) => (
                    <li key={i} className="truncate line-through">
                      {step.order}. {step.subject || "(no subject)"}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Will be created ({plan.steps.filter((s) => !s.isVariant).length} step
                {plan.steps.filter((s) => !s.isVariant).length === 1 ? "" : "s"}
                {plan.steps.some((s) => s.isVariant)
                  ? ` · ${plan.steps.filter((s) => s.isVariant).length} variant${
                      plan.steps.filter((s) => s.isVariant).length === 1 ? "" : "s"
                    }`
                  : ""}
                )
              </p>
              <ul className="max-h-52 space-y-1.5 overflow-y-auto rounded-md border p-2 text-xs">
                {plan.steps.map((step, i) => (
                  <li key={i}>
                    <span className="flex items-baseline gap-2">
                      {/* A variant has no position of its own — it replaces the
                          step above it — so numbering it would imply an extra
                          email that never gets sent. */}
                      <span className="tnum shrink-0 text-muted-foreground">
                        {step.isVariant ? "↳" : `${step.order}.`}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {step.subject || "(no subject)"}
                      </span>
                      {/* wait_in_days is the gap AFTER a step (EmailBison:
                          "how many days before the sequence moves to the next
                          step"), so the last step's is inert and a variant has
                          none of its own. */}
                      <span className="tnum shrink-0 text-muted-foreground">
                        {step.isVariant
                          ? ""
                          : step.waitInDays
                            ? `then ${step.waitInDays}d`
                            : ""}
                      </span>
                      {step.isVariant ? (
                        <span className="shrink-0 rounded border px-1">variant</span>
                      ) : null}
                    </span>
                    {step.opening ? (
                      <span className="block truncate pl-6 text-[11px] text-muted-foreground">
                        {step.opening}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>

            {blockedByVolume ? (
              <p className="rounded-md border border-red-300/60 bg-red-50 p-2.5 text-xs text-red-800">
                Replace is unavailable for this campaign. Switch to Append, or delete the sent
                steps in EmailBison first.
              </p>
            ) : null}

            {needsTyped && !blockedByVolume ? (
              <div className="space-y-1.5">
                <label htmlFor="confirm" className="text-xs">
                  Type <strong>{targetName}</strong> to confirm deleting its current sequence
                </label>
                <Input
                  id="confirm"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={targetName}
                  className="h-8 text-xs"
                />
              </div>
            ) : null}

            {commit.error ? (
              <p className="whitespace-pre-line rounded-md border border-red-300/60 bg-red-50 p-2 text-xs text-red-800">
                {commit.error.message}
              </p>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          {stage !== "pick" ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStage(stage === "review" ? "options" : "pick")}
              disabled={commit.isPending}
            >
              Back
            </Button>
          ) : null}

          {stage === "pick" ? (
            <Button size="sm" disabled={!sourceId} onClick={() => setStage("options")}>
              Continue
            </Button>
          ) : null}

          {stage === "options" ? (
            <Button size="sm" disabled={preview.isPending} onClick={() => preview.mutate()}>
              {preview.isPending ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
              Review changes
            </Button>
          ) : null}

          {stage === "review" ? (
            <Button
              size="sm"
              variant={plan?.removing.length ? "destructive" : "default"}
              disabled={!confirmed || blockedByVolume || commit.isPending || !plan?.steps.length}
              onClick={() => commit.mutate()}
            >
              {commit.isPending ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
              {plan?.removing.length
                ? `Replace ${plan.removing.length} step${plan.removing.length === 1 ? "" : "s"}`
                : `Add ${plan?.steps.length ?? 0} step${plan?.steps.length === 1 ? "" : "s"}`}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
