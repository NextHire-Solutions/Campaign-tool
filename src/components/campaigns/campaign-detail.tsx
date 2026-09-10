"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CopySequenceDialog } from "@/components/campaigns/copy-sequence-dialog";
import { PushSequenceDialog } from "@/components/campaigns/push-sequence-dialog";
import { ReCampaignDialog } from "@/components/campaigns/re-campaign-dialog";
import { FanOutDialog } from "@/components/campaigns/fan-out-dialog";
import { BulkDeployPanel, useBulkDeploy } from "@/components/analytics/bulk-deploy";
import { SequenceEditor, type EditableStep } from "@/components/campaigns/sequence-editor";
import {
  SequenceView,
  type SequenceStep as Step,
} from "@/components/campaigns/sequence-view";
import { CopyTagsPanel } from "@/components/campaigns/copy-tags-panel";
import { CampaignLeads } from "@/components/campaigns/campaign-leads";
import { OfferPicker } from "@/components/campaigns/offer-picker";
import { DASH, fullNumber, percent } from "@/lib/analytics/format.ts";
import { STATUS_TONE, canApply, isKnownStatus } from "@/lib/campaigns/status.ts";
import { cn } from "@/lib/utils";

/*
 * Campaign detail (spec §9.2).
 *
 * The header carries the essentials — daily limit, variant count, created date —
 * with one primary button that is Pause or Resume depending on status, and is
 * absent entirely when neither applies. A greyed-out primary button on a
 * completed campaign invites the click that queues 828 people to receive email.
 */

interface Campaign {
  id: number;
  name: string;
  status: string;
  tags: unknown[];
  total_leads: number | null;
  total_leads_contacted: number | null;
  lifetime_emails_sent: number | null;
  lifetime_opened: number | null;
  lifetime_unique_opens: number | null;
  lifetime_replied: number | null;
  lifetime_unique_replies: number | null;
  lifetime_bounced: number | null;
  lifetime_unsubscribed: number | null;
  lifetime_interested: number | null;
  completion_percentage: number | null;
  max_emails_per_day: number | null;
  max_new_leads_per_day: number | null;
  plain_text: boolean | null;
  open_tracking: boolean | null;
  can_unsubscribe: boolean | null;
  unsubscribe_text: string | null;
  include_auto_replies_in_stats: boolean | null;
  sequence_prioritization: string | null;
  eb_created_at: string | null;
  sequence_id: number | null;
  excluded: boolean;
  excludeReason: string | null;
}

interface Activity {
  id: number;
  action: string;
  actor: string;
  status: string;
  error: string | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  created_at: string;
}

interface DetailResponse {
  /** Absent on EmailBison responses, which predate the field. */
  platform?: "emailbison" | "instantly";
  campaign: Campaign;
  sequence: Step[];
  variantCount: number;
  activity: Activity[];
  sentStepIds: number[];
}

/*
 * WT §9.2 lists five tabs. "Copy & Offer" — the dimension tags for each email
 * and which offer this campaign sells — existed only nested inside Sequence,
 * where you had to expand a step to reach it. Its own tab, per the spec.
 */
const TABS = ["Overview", "Leads", "Sequence", "Copy & Offer", "Settings", "Activity"] as const;

/*
 * Which tabs an Instantly campaign has.
 *
 * Sequence and Copy & Offer are here now that 087 syncs the steps — they were
 * hidden for a gap that existed only because nothing had fetched the bodies,
 * which the API returns on the campaign object all along.
 *
 * SETTINGS REMAINS OUT, and that one is a real difference rather than pending
 * work: it writes EmailBison's campaign-update endpoint field by field, and
 * Instantly's equivalent is a PATCH with a different body. Showing it would
 * offer controls whose saves would fail — the "shows the change as saved when
 * it wasn't" that spec §9.5 forbids.
 */
const INSTANTLY_TABS = new Set<(typeof TABS)[number]>([
  "Overview",
  "Leads",
  "Sequence",
  "Copy & Offer",
  "Activity",
]);
type Tab = (typeof TABS)[number];

export function CampaignDetail({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("Overview");
  /*
   * The tab list depends on the platform, and the SELECTED tab is corrected
   * during render rather than in an effect — the React Compiler lint forbids
   * setState in an effect, and deriving it here means the page can never paint
   * a tab that does not exist for this campaign.
   */

  const { data, isLoading, error } = useQuery<DetailResponse>({
    queryKey: ["campaign", id],
    queryFn: async () => {
      const response = await fetch(`/api/campaigns/${id}`);
      if (!response.ok) {
        throw new Error((await response.json()).error ?? "Failed to load campaign");
      }
      return response.json();
    },
    staleTime: 30_000,
  });

  const act = useMutation({
    mutationFn: async (action: "pause" | "resume") => {
      const response = await fetch("/api/campaigns/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, campaignIds: [id], confirm: true }),
      });
      const body = await response.json();
      if (!response.ok && response.status !== 207) {
        throw new Error(body.error ?? "The action could not be applied");
      }
      const result = body.results?.[0];
      if (result && !result.ok) throw new Error(result.error);
      return body;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaign", id] });
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
    },
  });

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">
          {error instanceof Error ? error.message : "Campaign not found"}
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href="/campaigns">Back to campaigns</Link>
        </Button>
      </div>
    );
  }

  const { campaign, sequence, variantCount, activity, sentStepIds } = data;

  /*
   * The tab list depends on the platform, and the SELECTED tab is corrected
   * during render rather than in an effect — the React Compiler lint forbids
   * setState in an effect, and deriving it here means the page can never paint
   * a tab this campaign does not have.
   */
  const isInstantly = data.platform === "instantly";
  const visibleTabs = TABS.filter((t) => !isInstantly || INSTANTLY_TABS.has(t));
  const activeTab: Tab = visibleTabs.includes(tab) ? tab : "Overview";

  // Shown only when it can actually be applied. Neither → no primary button.
  const primary = canApply("pause", campaign.status)
    ? ("pause" as const)
    : canApply("resume", campaign.status)
      ? ("resume" as const)
      : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-muted/30">
      <header className="shrink-0 border-b bg-card px-8 py-4">
        <Link
          href="/campaigns"
          className="mb-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3" />
          Campaigns
        </Link>

        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-medium" title={campaign.name}>
              {campaign.name}
            </h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <StatusChip status={campaign.status} />
              <span className="tnum">
                {fullNumber(campaign.max_emails_per_day)}/day
              </span>
              <span>·</span>
              <span className="tnum">
                {variantCount} {variantCount === 1 ? "variant" : "variants"}
              </span>
              <span>·</span>
              <span>
                Created{" "}
                {campaign.eb_created_at
                  ? new Date(campaign.eb_created_at).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })
                  : "—"}
              </span>
              {campaign.excluded ? (
                <>
                  <span>·</span>
                  <span className="italic">excluded — {campaign.excludeReason}</span>
                </>
              ) : null}
            </p>
          </div>

          {primary ? (
            <Button
              size="sm"
              variant={primary === "resume" ? "default" : "outline"}
              disabled={act.isPending}
              onClick={() => {
                if (
                  primary === "resume" &&
                  !window.confirm(
                    `Resume "${campaign.name}"?\n\nThis queues the campaign to send. ` +
                      `${fullNumber(campaign.total_leads)} leads are attached and may begin ` +
                      `receiving email. It does not restore a previous status.`,
                  )
                ) {
                  return;
                }
                act.mutate(primary);
              }}
              className="gap-1.5"
            >
              {act.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : primary === "pause" ? (
                <Pause className="size-3.5" />
              ) : (
                <Play className="size-3.5" />
              )}
              {primary === "pause" ? "Pause" : "Resume"}
            </Button>
          ) : null}
        </div>

        {act.error ? (
          <p className="mt-2 rounded-md border border-red-300/60 bg-red-50 p-2 text-xs text-red-800">
            {act.error.message}
          </p>
        ) : null}
      </header>

      <div className="flex shrink-0 gap-0.5 border-b bg-card px-8">
        {visibleTabs.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-xs transition-colors",
              activeTab === t
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t}
            {t === "Activity" && activity.length ? (
              <span className="tnum ml-1.5 text-muted-foreground">{activity.length}</span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        {activeTab === "Overview" ? <Overview campaign={campaign} platform={data.platform} /> : null}
        {activeTab === "Leads" ? (
          <CampaignLeads campaignId={String(campaign.id)} campaignName={campaign.name} />
        ) : null}
        {activeTab === "Sequence" ? (
          <Sequence
            steps={sequence}
            campaignId={campaign.id}
            campaignName={campaign.name}
            sequenceId={campaign.sequence_id ?? null}
            sentStepIds={sentStepIds ?? []}
          />
        ) : null}
        {activeTab === "Copy & Offer" ? (
          <CopyAndOffer campaignId={campaign.id} steps={sequence} />
        ) : null}
        {activeTab === "Settings" ? <Settings campaign={campaign} /> : null}
        {activeTab === "Activity" ? <ActivityLog rows={activity} /> : null}
      </div>
    </div>
  );
}

/**
 * Copy & Offer for one campaign (WT §9.2).
 *
 * Two things on one screen because they answer the same question — "what is
 * this campaign actually selling, and how is it worded?"
 *
 * Only the FIRST email is taggable, matching the analysis: later steps inherit
 * the opener's framing, so tagging them separately would create dimensions that
 * cannot be compared. Follow-ups are listed but read-only, so the sequence is
 * still visible without implying they carry their own copy identity.
 */
function CopyAndOffer({ campaignId, steps }: { campaignId: number; steps: Step[] }) {
  const ordered = [...steps].sort((a, b) => (a.step_order ?? 0) - (b.step_order ?? 0));
  const first = ordered[0] ?? null;
  const followUps = ordered.slice(1);

  if (!first) {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">
        This campaign has no sequence yet, so there is no copy to tag.
      </p>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <section className="rounded-xl border bg-card">
        <div className="border-b px-5 py-3">
          <h2 className="text-sm font-semibold">Offer</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Which offer this campaign sells. Offers are tracked in their own right on
            the Copy &amp; Offer tab, not just as campaign names.
          </p>
        </div>
        <div className="px-5 py-4">
          <OfferPicker campaignId={campaignId} />
        </div>
      </section>

      <section className="rounded-xl border bg-card">
        <div className="border-b px-5 py-3">
          <h2 className="text-sm font-semibold">Copy dimensions</h2>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {first.email_subject || "(no subject)"}
          </p>
        </div>
        <div className="px-5 py-4">
          <CopyTagsPanel stepId={first.id} isFirstEmail />
        </div>
      </section>

      {followUps.length ? (
        <section className="rounded-xl border bg-card">
          <div className="border-b px-5 py-3">
            <h2 className="text-sm font-semibold">Follow-ups</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Not tagged. Copy analysis covers the opening email only — a follow-up
              inherits its framing, so tagging it separately would compare a
              dimension against itself.
            </p>
          </div>
          <ul className="divide-y">
            {followUps.map((step, i) => (
              <li key={step.id} className="flex items-baseline gap-3 px-5 py-2.5 text-sm">
                <span className="tnum shrink-0 text-xs text-muted-foreground">
                  Step {i + 2}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {step.email_subject || "(no subject)"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const tone = isKnownStatus(status) ? STATUS_TONE[status] : "bg-red-100 text-red-800";
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium capitalize", tone)}>
      {status}
    </span>
  );
}

function Overview({
  campaign,
  platform,
}: {
  campaign: Campaign;
  platform?: "emailbison" | "instantly";
}) {
  const platformName = platform === "instantly" ? "Instantly" : "EmailBison";
  const sent = campaign.lifetime_emails_sent ?? 0;

  /*
   * A funnel, not a bar chart: each stage is a share of the one above it, so
   * the bars are drawn relative to `sent` rather than to each other. Drawing
   * them relative to the largest value would make a 1% reply rate look like a
   * full bar whenever nothing else happened.
   */
  /*
   * `?? 0` REMOVED, deliberately (rule 1). Instantly reports no "interested"
   * count at all, and this rendered it as "0 — 0.00%" beside a real reply
   * count: a confident claim that nobody was interested, made about a number
   * the platform never sent. A null now falls through to DASH, and its bar is
   * simply not drawn.
   */
  const funnel = [
    { label: "Sent", value: sent, tone: "bg-[#2a78d6]" },
    { label: "Replied", value: campaign.lifetime_unique_replies ?? null, tone: "bg-[#eb6834]" },
    { label: "Interested", value: campaign.lifetime_interested ?? null, tone: "bg-[#008300]" },
    { label: "Bounced", value: campaign.lifetime_bounced ?? null, tone: "bg-[#e34948]" },
  ];

  const stats = [
    ["Leads", campaign.total_leads],
    ["Leads contacted", campaign.total_leads_contacted],
    ["Emails sent", campaign.lifetime_emails_sent],
    ["Opens", campaign.lifetime_opened],
    ["Unique opens", campaign.lifetime_unique_opens],
    ["Replies", campaign.lifetime_replied],
    ["Unique replies", campaign.lifetime_unique_replies],
    ["Interested", campaign.lifetime_interested],
    ["Bounced", campaign.lifetime_bounced],
    ["Unsubscribed", campaign.lifetime_unsubscribed],
  ] as const;

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[1.3fr_1fr]">
      <div className="space-y-5">
      <section className="rounded-xl border bg-card p-5 shadow-sm">
        <div className="mb-1.5 flex items-baseline justify-between">
          <h2 className="text-sm font-medium">
            Progress
          </h2>
          <span className="tnum text-xs text-muted-foreground">
            {campaign.completion_percentage != null
              ? percent(campaign.completion_percentage / 100)
              : "—"}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-foreground/70 transition-[width]"
            style={{ width: `${Math.min(campaign.completion_percentage ?? 0, 100)}%` }}
          />
        </div>
      </section>

      <section className="rounded-xl border bg-card p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-medium">
          Funnel <span className="font-normal text-muted-foreground">(lifetime)</span>
        </h2>
        <div className="space-y-1.5">
          {funnel.map((stage) => (
            <div key={stage.label} className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-xs text-muted-foreground">{stage.label}</span>
              <div className="h-4 min-w-0 flex-1 overflow-hidden rounded bg-muted">
                {/* No bar for a value the platform never reported — a
                    zero-width bar and a genuine zero look identical, and only
                    one of them is a fact. */}
                <div
                  className={cn("h-full rounded", stage.tone)}
                  style={{
                    width:
                      sent && stage.value !== null
                        ? `${(stage.value / sent) * 100}%`
                        : "0%",
                  }}
                />
              </div>
              <span className="tnum w-20 shrink-0 text-right text-xs">
                {fullNumber(stage.value)}
              </span>
              <span className="tnum w-14 shrink-0 text-right text-xs text-muted-foreground">
                {sent && stage.value !== null ? percent(stage.value / sent, 2) : DASH}
              </span>
            </div>
          ))}
        </div>
        {/* These are cumulative counters from the SENDING PLATFORM, not the
            day-based figures the Analytics tab computes. Saying so stops the
            two being read as a discrepancy — and naming the right platform
            matters now that half these campaigns are not EmailBison's. */}
        <p className="mt-2 text-[11px] text-muted-foreground">
          Lifetime totals as {platformName} reports them. For a date range, use Analytics.
        </p>
      </section>

      </div>

      <div className="space-y-5">
      <section className="rounded-xl border bg-card p-5 shadow-sm">
        <h2 className="mb-2 text-sm font-medium">
          Detail
        </h2>
        <dl className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
          {stats.map(([label, value]) => (
            <div key={label} className="flex justify-between border-b py-1.5 text-xs">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="tnum">{fullNumber(value)}</dd>
            </div>
          ))}
        </dl>
      </section>

      {Array.isArray(campaign.tags) && campaign.tags.length ? (
        <section className="rounded-xl border bg-card p-5 shadow-sm">
          <h2 className="mb-2 text-sm font-medium">
            Tags
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {campaign.tags.map((tag, i) => {
              const label =
                typeof tag === "string"
                  ? tag
                  : ((tag as { name?: string })?.name ?? JSON.stringify(tag));
              return (
                <span key={i} className="rounded border bg-card px-2 py-0.5 text-xs">
                  {label}
                </span>
              );
            })}
          </div>
        </section>
      ) : null}
      </div>
    </div>
  );
}

function Sequence({
  steps,
  campaignId,
  campaignName,
  sequenceId,
  sentStepIds,
}: {
  steps: Step[];
  campaignId: number;
  campaignName: string;
  sequenceId: number | null;
  sentStepIds: number[];
}) {
  const [copying, setCopying] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [reCampaigning, setReCampaigning] = useState(false);
  const [fanningOut, setFanningOut] = useState(false);
  const [editing, setEditing] = useState(false);
  const deploy = useBulkDeploy();

  /*
   * Variants are flattened back out for editing. The read view nests them under
   * their parent, but EmailBison's sequence is a flat ordered list and saving a
   * nested shape would have to invent an ordering for the variants.
   */
  const editable: EditableStep[] = steps
    .flatMap((step) => [step, ...step.variants])
    .map((step) => ({
      key: `s${step.id}`,
      id: step.id,
      email_subject: step.email_subject ?? "",
      email_body: step.email_body ?? "",
      wait_in_days: step.wait_in_days ?? 0,
      thread_reply: Boolean(step.thread_reply),
      variant: Boolean(step.is_variant),
    }));

  if (editing) {
    return (
      <SequenceEditor
        campaignId={campaignId}
        sequenceId={sequenceId}
        initial={editable}
        sentStepIds={sentStepIds}
        onDone={() => setEditing(false)}
      />
    );
  }

  const copyButton = (
    <>
      <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setEditing(true)}>
        Edit sequence
      </Button>
      <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setCopying(true)}>
        Copy sequence from…
      </Button>
      {/* The other direction. This campaign's sequence is often the proven one,
          and rolling it out was previously only possible from an offer card —
          which meant creating an offer just to reuse a sequence. */}
      <Button
        size="sm"
        className="h-8 text-xs"
        disabled={!steps.length}
        onClick={() => setPushing(true)}
      >
        Push to campaigns…
      </Button>
      {/* Duplicate & re-campaign. Sits beside the sequence tools because that
          is what it copies — EmailBison's own duplicate carries the sequence
          and nothing else, which is the gap this closes. */}
      <Button
        variant="outline"
        size="sm"
        className="h-8 text-xs"
        onClick={() => setReCampaigning(true)}
      >
        Re-campaign…
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-8 text-xs"
        onClick={() => setFanningOut(true)}
      >
        For multiple clients…
      </Button>
      <ReCampaignDialog
        campaignId={campaignId}
        campaignName={campaignName}
        open={reCampaigning}
        onOpenChange={setReCampaigning}
      />
      <FanOutDialog
        campaignId={campaignId}
        campaignName={campaignName}
        open={fanningOut}
        onOpenChange={setFanningOut}
      />
      <CopySequenceDialog
        targetId={campaignId}
        targetName={campaignName}
        open={copying}
        onOpenChange={setCopying}
      />
      <PushSequenceDialog
        sourceId={campaignId}
        sourceName={campaignName}
        // Steps only. A variant is an alternative wording at an existing
        // position, so counting it here overstates what gets pushed.
        stepCount={steps.filter((s) => !s.is_variant).length}
        open={pushing}
        onOpenChange={setPushing}
        onStart={deploy.start}
      />
    </>
  );

  if (!steps.length) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 rounded-xl border bg-card p-5 shadow-sm">
        <p className="text-sm text-muted-foreground">
          This campaign has no sequence steps cached. Run sync-steps if it has one upstream, or
          copy a sequence from another campaign.
        </p>
        <div className="flex gap-2">{copyButton}</div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <BulkDeployPanel
        batch={deploy.batch}
        running={deploy.running}
        onRetry={deploy.retryFailed}
        onDismiss={deploy.dismiss}
      />
      <div className="flex flex-wrap justify-end gap-2">{copyButton}</div>
      <SequenceView steps={steps} />
    </div>
  );
}

/*
 * Grouped into sections rather than one long column of unrelated fields.
 * Naming, sending limits and content behaviour are three different decisions,
 * and stacking them flat made the panel read as a settings dump with no
 * hierarchy. Centred to match every other tab — left-aligned at max-w-2xl it
 * left most of a wide screen empty.
 */
function Settings({ campaign }: { campaign: Campaign }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: campaign.name,
    max_emails_per_day: campaign.max_emails_per_day ?? 0,
    max_new_leads_per_day: campaign.max_new_leads_per_day ?? 0,
    plain_text: campaign.plain_text ?? false,
    open_tracking: campaign.open_tracking ?? false,
    can_unsubscribe: campaign.can_unsubscribe ?? false,
    include_auto_replies_in_stats: campaign.include_auto_replies_in_stats ?? false,
  });

  const save = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/campaigns/${campaign.id}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not save settings");
      return body;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaign", campaign.id] });
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
    },
  });

  // §9.3: "Changes are saved only when you press Save."
  const dirty =
    form.name !== campaign.name ||
    form.max_emails_per_day !== (campaign.max_emails_per_day ?? 0) ||
    form.max_new_leads_per_day !== (campaign.max_new_leads_per_day ?? 0) ||
    form.plain_text !== (campaign.plain_text ?? false) ||
    form.open_tracking !== (campaign.open_tracking ?? false) ||
    form.can_unsubscribe !== (campaign.can_unsubscribe ?? false) ||
    form.include_auto_replies_in_stats !== (campaign.include_auto_replies_in_stats ?? false);

  const toggles = [
    ["open_tracking", "Open tracking", "Adds a tracking pixel to every email."],
    ["plain_text", "Plain text", "Sends without HTML formatting."],
    ["can_unsubscribe", "One-click unsubscribe", "Adds an unsubscribe link."],
    [
      "include_auto_replies_in_stats",
      "Count auto-replies in stats",
      "Out-of-office replies counted as replies.",
    ],
  ] as const;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <section className="space-y-1.5 rounded-xl border bg-card p-5 shadow-sm">
        <label htmlFor="name" className="text-xs font-medium">
          Campaign name
        </label>
        <Input
          id="name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          className="h-8 text-sm"
        />
        {/* Renaming moves the campaign between clients, because attribution is
            matched on the name. Worth saying before it happens, not after. */}
        <p className="text-[11px] text-muted-foreground">
          The client is derived from this name — renaming can reassign the campaign.
        </p>
      </section>

      <section className="rounded-xl border bg-card p-5 shadow-sm">
        <h3 className="mb-3 text-xs font-semibold">Sending limits</h3>
        <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="limit" className="text-xs font-medium">
            Daily send limit
          </label>
          <Input
            id="limit"
            type="number"
            min={0}
            value={form.max_emails_per_day}
            onChange={(e) => setForm({ ...form, max_emails_per_day: Number(e.target.value) })}
            className="tnum h-8 text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="leads" className="text-xs font-medium">
            New leads per day
          </label>
          <Input
            id="leads"
            type="number"
            min={0}
            value={form.max_new_leads_per_day}
            onChange={(e) => setForm({ ...form, max_new_leads_per_day: Number(e.target.value) })}
            className="tnum h-8 text-sm"
          />
        </div>
        </div>
      </section>

      <section className="rounded-xl border bg-card p-5 shadow-sm">
        <h3 className="mb-3 text-xs font-semibold">Content and tracking</h3>
        <div className="space-y-2.5">
        {toggles.map(([key, label, hint]) => (
          <label key={key} className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={form[key]}
              onChange={(e) => setForm({ ...form, [key]: e.target.checked })}
              className="mt-0.5 size-3.5 accent-foreground"
            />
            <span className="min-w-0">
              <span className="block text-xs font-medium">{label}</span>
              <span className="block text-[11px] text-muted-foreground">{hint}</span>
            </span>
          </label>
        ))}
        </div>

        {campaign.can_unsubscribe && campaign.unsubscribe_text ? (
          <div className="mt-4 space-y-1.5 border-t pt-4">
            <p className="text-xs font-medium">Unsubscribe wording</p>
            <p className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
              {campaign.unsubscribe_text}
            </p>
          </div>
        ) : null}
      </section>

      {/* Sticky, so Save is reachable without scrolling back up once the
          sections grow. */}
      <div className="sticky bottom-0 flex items-center gap-3 rounded-xl border bg-card px-5 py-3 shadow-sm">
        <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
          Save changes
        </Button>
        {dirty ? (
          <span className="text-xs text-muted-foreground">Unsaved changes</span>
        ) : save.isSuccess ? (
          <span className="text-xs text-emerald-700">Saved to EmailBison</span>
        ) : null}

        {save.error ? (
          <p className="ml-auto max-w-md rounded-md border border-red-300/60 bg-red-50 p-2 text-xs text-red-800">
            {/* §9.5: the platform's actual reason, and the form still shows the
                edit as unsaved. */}
            {save.error.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** §9.2 Activity: "what changed, and what it was before". */
function ActivityLog({ rows }: { rows: Activity[] }) {
  if (!rows.length) {
    return (
      <p className="text-sm text-muted-foreground">
        No changes recorded yet. Every pause, resume, archive and settings edit made here
        appears in this list.
      </p>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-2">
      {rows.map((row) => (
        <div
          key={row.id}
          className={cn(
            "rounded-xl border bg-card p-3 text-xs shadow-sm",
            row.status === "error" && "border-red-300/60 bg-red-50/50",
          )}
        >
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-medium capitalize">{row.action}</span>
            {row.status === "error" ? (
              <span className="rounded bg-red-100 px-1.5 text-[11px] text-red-800">failed</span>
            ) : null}
            <span className="text-muted-foreground">{row.actor}</span>
            <span className="ml-auto text-muted-foreground">
              {new Date(row.created_at).toLocaleString()}
            </span>
          </div>

          {row.error ? <p className="mt-1.5 text-red-800">{row.error}</p> : null}

          {row.before_state ? (
            <dl className="mt-1.5 space-y-0.5 text-[11px]">
              {Object.entries(row.before_state).map(([key, before]) => {
                const after = row.after_state?.[key];
                if (after === undefined) return null;
                return (
                  <div key={key} className="flex gap-2">
                    <dt className="text-muted-foreground">{key}</dt>
                    <dd className="flex gap-1.5">
                      <span className="text-muted-foreground line-through">
                        {String(before)}
                      </span>
                      <span>→</span>
                      <span className="font-medium">{String(after)}</span>
                    </dd>
                  </div>
                );
              })}
            </dl>
          ) : null}
        </div>
      ))}
    </div>
  );
}
