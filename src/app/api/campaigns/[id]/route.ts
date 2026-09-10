import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase/server";
import { platformOfId } from "@/lib/campaigns/campaign-id.ts";

/** Instantly's integer status, in the words the rest of the app already uses. */
function instantlyStatusWord(code: number): string {
  return { 0: "draft", 1: "active", 2: "paused", 3: "completed" }[code] ?? "error";
}

/*
 * One campaign, everything the detail page shows (spec §9.2): the header
 * essentials, the lifetime funnel, the sequence with per-step performance, the
 * settings, and the activity log.
 *
 * Served entirely from cache in one round of parallel queries — no EmailBison
 * call. The five reads below are issued together rather than awaited in
 * sequence, so the page costs one network round trip's latency, not five.
 *
 * Step performance is summed in SQL-shaped reads over campaign_step_stats_daily
 * rather than taken from any lifetime counter, because a step's totals must
 * agree with the analytics side of the app, which is day-based.
 */

export const dynamic = "force-dynamic";

const TEAM_ID = () => Number(process.env.EMAILBISON_TEAM_ID || 2);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const platform = platformOfId(id);
  if (!platform) {
    return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 });
  }

  const sb = getSupabase();
  const teamId = TEAM_ID();

  /*
   * INSTANTLY GETS A DELIBERATELY SMALLER PAYLOAD, and the omissions are real
   * rather than unfinished work. We do not sync its sequence steps, it has no
   * per-step stats, and Copy & Offer reads sequence bodies — so those come back
   * empty and the page hides the tabs instead of drawing them blank. An empty
   * Sequence tab reads as "this campaign has no emails", which is false.
   */
  if (platform === "instantly") {
    const [campaign, mapping, activity] = await Promise.all([
      sb.from("instantly_campaigns").select("*").eq("id", id).eq("team_id", teamId).maybeSingle(),
      sb
        .from("instantly_campaign_clients")
        .select("client_id, excluded, exclude_reason, match_method, matched_on")
        .eq("campaign_id", id)
        .maybeSingle(),
      sb
        .from("campaign_audit_log")
        .select("id, action, actor, status, error, before_state, after_state, created_at")
        .eq("platform", "instantly")
        .eq("campaign_ref", id)
        .order("id", { ascending: false })
        .limit(100),
    ]);
    if (campaign.error) {
      return NextResponse.json({ error: campaign.error.message }, { status: 500 });
    }
    if (!campaign.data) {
      return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
    }
    const c = campaign.data as Record<string, unknown>;
    return NextResponse.json({
      platform,
      campaign: {
        ...c,
        // The page's shared vocabulary; Instantly reports an integer.
        status: instantlyStatusWord(Number(c.status)),
        total_leads: c.leads_count ?? null,
        lifetime_emails_sent: c.emails_sent ?? null,
        lifetime_unique_replies: c.reply_count_unique ?? null,
        clientId: mapping.data?.client_id ?? null,
        excluded: Boolean(mapping.data?.excluded),
      },
      sequence: [],
      variantCount: 0,
      activity: activity.data ?? [],
      sentStepIds: [],
    });
  }

  const campaignId = Number(id);

  const [campaign, offer, steps, stepStats, activity, mapping] = await Promise.all([
    sb.from("campaigns").select("*").eq("id", campaignId).eq("team_id", teamId).maybeSingle(),
    // Which offer this campaign sells, for the Copy & Offer tab's picker.
    sb.from("campaign_offers").select("offer_id").eq("campaign_id", campaignId).maybeSingle(),
    sb
      .from("sequence_steps")
      .select(
        "id, step_order, email_subject, email_body, wait_in_days, is_variant, variant_from_step_id, thread_reply, attachments",
      )
      .eq("campaign_id", campaignId)
      .order("step_order", { ascending: true }),
    sb
      .from("campaign_step_stats_daily")
      .select("sequence_step_id, sent, leads_contacted, unique_opens, unique_replies, bounced, unsubscribed, interested")
      .eq("campaign_id", campaignId),
    sb
      .from("campaign_audit_log")
      .select("id, action, actor, status, error, before_state, after_state, created_at")
      .eq("campaign_id", campaignId)
      .order("id", { ascending: false })
      .limit(100),
    sb
      .from("campaign_clients")
      .select("client_id, excluded, exclude_reason, match_method, matched_on")
      .eq("campaign_id", campaignId)
      .maybeSingle(),
  ]);

  if (campaign.error) {
    return NextResponse.json({ error: campaign.error.message }, { status: 500 });
  }
  if (!campaign.data) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  // Roll the daily step rows up per step. Done here rather than in an RPC
  // because it is a handful of rows per campaign, always scoped by campaign_id.
  const perStep = new Map<
    number,
    { sent: number; contacted: number; opens: number; replies: number; bounced: number; unsubscribed: number; interested: number }
  >();
  for (const row of stepStats.data ?? []) {
    const acc = perStep.get(row.sequence_step_id) ?? {
      sent: 0, contacted: 0, opens: 0, replies: 0, bounced: 0, unsubscribed: 0, interested: 0,
    };
    acc.sent += row.sent ?? 0;
    acc.contacted += row.leads_contacted ?? 0;
    acc.opens += row.unique_opens ?? 0;
    acc.replies += row.unique_replies ?? 0;
    acc.bounced += row.bounced ?? 0;
    acc.unsubscribed += row.unsubscribed ?? 0;
    acc.interested += row.interested ?? 0;
    perStep.set(row.sequence_step_id, acc);
  }

  const allSteps = (steps.data ?? []).map((s) => ({ ...s, stats: perStep.get(s.id) ?? null }));

  /*
   * Variants nest under their parent step (§9.3: "Variants sit nested under
   * their parent step, each with its performance shown alongside").
   *
   * A variant whose parent is missing — the parent was deleted upstream but the
   * variant row survives — is promoted to a top-level step rather than dropped.
   * Silently losing a step that still has send volume attributed to it is how
   * the sequence view stops adding up to the campaign.
   */
  const parents = allSteps.filter((s) => !s.is_variant);
  const parentIds = new Set(parents.map((p) => p.id));
  const orphans = allSteps.filter(
    (s) => s.is_variant && (s.variant_from_step_id == null || !parentIds.has(s.variant_from_step_id)),
  );

  const sequence = [...parents, ...orphans]
    .sort((a, b) => (a.step_order ?? 0) - (b.step_order ?? 0))
    .map((step) => ({
      ...step,
      orphanedVariant: step.is_variant,
      variants: allSteps.filter((v) => v.is_variant && v.variant_from_step_id === step.id),
    }));

  // Steps EmailBison will refuse to delete, so the editor can disable removal
  // rather than let a save fail halfway.
  const sentStepIds = [
    ...new Set(
      (stepStats.data ?? []).filter((r) => (r.sent ?? 0) > 0).map((r) => r.sequence_step_id),
    ),
  ];

  return NextResponse.json({
    sentStepIds,
    campaign: {
      ...campaign.data,
      clientId: mapping.data?.client_id ?? null,
      excluded: Boolean(mapping.data?.excluded),
      excludeReason: mapping.data?.exclude_reason ?? null,
      matchMethod: mapping.data?.match_method ?? null,
      matchedOn: mapping.data?.matched_on ?? null,
      offer_id: offer.data?.offer_id ?? null,
    },
    sequence,
    variantCount: allSteps.filter((s) => s.is_variant).length,
    activity: activity.data ?? [],
  });
}
