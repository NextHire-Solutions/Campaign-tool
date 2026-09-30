import { createEmailBisonClient } from "@/lib/emailbison/client.ts";
import { createInstantlyClient } from "@/lib/instantly/client.ts";
import { getSupabase } from "@/lib/supabase/server";

import { stepPermissions, type RuleStep, type StepPermission } from "./sequence-rules.ts";

/*
 * The campaign's sequence as the PLATFORM has it right now, with what each
 * step may do (sequence-rules.ts), and the two actions: delete a never-sent
 * step or variant, turn a sent one off or on. Read live every time — the
 * synced copy has no on/off state and can lag — and every action re-reads and
 * re-checks on the server before touching anything.
 */

export type Platform = "emailbison" | "instantly";
export type LiveStep = RuleStep & StepPermission & { order: number; subject: string };
export interface LiveSequence { platform: Platform; status: string; steps: LiveStep[] }

export class SequenceActionError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "SequenceActionError"; }
}

const INSTANTLY_STATUS: Record<number, string> = { 0: "draft", 1: "active", 2: "paused", 3: "completed" };

type EbStep = { id: number; order: number | string; variant: boolean; variant_from_step_id: number | null; active: boolean; email_subject: string | null };
type InSeq = Array<{ steps?: Array<{ delay?: number; delay_unit?: string; type?: string; variants?: Array<{ subject?: string; body?: string; v_disabled?: boolean }> }> }>;

async function liveEmailBison(campaignId: number) {
  const eb = createEmailBisonClient();
  const [camp, seq, stats] = await Promise.all([
    eb.getCampaign(campaignId),
    eb.getCampaignSequenceSteps(campaignId).catch(() => null),
    getSupabase().from("campaign_step_stats_daily").select("sequence_step_id, sent").eq("campaign_id", campaignId),
  ]);
  const sent = new Map<number, number>();
  for (const r of (stats.data ?? []) as { sequence_step_id: number; sent: number | null }[]) {
    sent.set(r.sequence_step_id, (sent.get(r.sequence_step_id) ?? 0) + (r.sent ?? 0));
  }
  const raw = ((seq?.data as { sequence_steps?: EbStep[] } | undefined)?.sequence_steps ?? []) as EbStep[];
  const steps: (RuleStep & { order: number; subject: string })[] = raw.map((s) => ({
    key: String(s.id), isVariant: Boolean(s.variant), parentKey: s.variant && s.variant_from_step_id ? String(s.variant_from_step_id) : null,
    sent: sent.get(s.id) ?? 0, active: s.active !== false, order: Number(s.order), subject: s.email_subject ?? "",
  }));
  return { status: String((camp as { status?: string }).status ?? "").toLowerCase(), steps, sequenceId: (seq?.data as { sequence_id?: number } | undefined)?.sequence_id ?? null };
}

async function liveInstantly(campaignId: string) {
  const client = createInstantlyClient();
  const c = await client.getCampaign(campaignId);
  const seqs = (c.sequences ?? []) as InSeq;
  // Per-step sends; unknown (null) when Instantly will not say.
  const sent = new Map<string, number>();
  let sentKnown = true;
  try {
    const rows = (await client.stepAnalytics(campaignId)) as Array<{ step?: string | number; variant?: string | number; sent?: number }>;
    for (const r of rows) sent.set(`${Number(r.step)}:${Number(r.variant)}`, Number(r.sent ?? 0));
  } catch {
    sentKnown = false;
  }
  const steps: (RuleStep & { order: number; subject: string })[] = [];
  (seqs[0]?.steps ?? []).forEach((st, i) => (st.variants ?? []).forEach((v, j) => steps.push({
    key: `${i}:${j}`, isVariant: j > 0, parentKey: j > 0 ? `${i}:0` : null,
    sent: sentKnown ? (sent.get(`${i}:${j}`) ?? 0) : null, active: !v.v_disabled, order: i + 1, subject: v.subject ?? "",
  })));
  return { status: INSTANTLY_STATUS[Number(c.status)] ?? "other", steps, seqs };
}

function withPermissions(platform: Platform, status: string, steps: (RuleStep & { order: number; subject: string })[]): LiveStep[] {
  return steps.map((s) => ({ ...s, ...stepPermissions(platform, status, steps, s.key) }));
}

export async function liveSequence(platform: Platform, campaignId: string): Promise<LiveSequence> {
  if (platform === "emailbison") {
    const l = await liveEmailBison(Number(campaignId));
    return { platform, status: l.status, steps: withPermissions(platform, l.status, l.steps) };
  }
  const l = await liveInstantly(campaignId);
  return { platform, status: l.status, steps: withPermissions(platform, l.status, l.steps) };
}

export type SequenceAction = "delete" | "turn-off" | "turn-on";

export async function applySequenceAction(platform: Platform, campaignId: string, key: string, action: SequenceAction, actor: string, teamId: number): Promise<LiveSequence> {
  const sb = getSupabase();
  const audit = async (status: "ok" | "error", detail: Record<string, unknown>, error?: string) => {
    await sb.from("campaign_audit_log").insert(platform === "emailbison"
      ? { team_id: teamId, campaign_id: Number(campaignId), action: `sequence-${action}`, actor, status, error: error ?? null, before_state: detail, after_state: null }
      : { team_id: teamId, campaign_id: null, platform: "instantly", campaign_ref: campaignId, action: `sequence-${action}`, actor, status, error: error ?? null, before_state: detail, after_state: null });
  };

  if (platform === "emailbison") {
    const l = await liveEmailBison(Number(campaignId));
    const step = l.steps.find((s) => s.key === key);
    const p = stepPermissions(platform, l.status, l.steps, key);
    if (action === "delete" && !p.canDelete) throw new SequenceActionError(p.deleteWhy ?? "Not allowed.");
    if (action !== "delete" && !p.canToggle) throw new SequenceActionError(p.toggleWhy ?? "Not allowed.");
    if (action === "turn-off" && step && !step.active) throw new SequenceActionError("It is already off.");
    if (action === "turn-on" && step && step.active) throw new SequenceActionError("It is already on.");
    const eb = createEmailBisonClient();
    try {
      if (action === "delete") {
        await eb.deleteSequenceStep(Number(key));
        // The synced copy the read view draws from: drop the row now rather than wait for the sync.
        await sb.from("sequence_steps").delete().eq("id", Number(key)).eq("campaign_id", Number(campaignId));
      } else {
        await eb.setSequenceStepActive(Number(key), action === "turn-on");
      }
      await audit("ok", { step: key, subject: step?.subject, sent: step?.sent });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await audit("error", { step: key }, msg);
      throw new SequenceActionError(`EmailBison refused: ${msg}`, 502);
    }
    return liveSequence(platform, campaignId);
  }

  const l = await liveInstantly(campaignId);
  const step = l.steps.find((s) => s.key === key);
  const p = stepPermissions(platform, l.status, l.steps, key);
  if (action === "delete" && !p.canDelete) throw new SequenceActionError(p.deleteWhy ?? "Not allowed.");
  if (action !== "delete" && !p.canToggle) throw new SequenceActionError(p.toggleWhy ?? "Not allowed.");
  const [i, j] = key.split(":").map(Number);
  const seqs = structuredClone(l.seqs);
  const steps = seqs[0]?.steps ?? [];
  if (!steps[i]?.variants?.[j]) throw new SequenceActionError("This step is no longer in the campaign.");
  if (action === "delete") {
    if (steps[i].variants!.length === 1) steps.splice(i, 1); else steps[i].variants!.splice(j, 1);
  } else {
    steps[i].variants![j].v_disabled = action === "turn-off";
  }
  const client = createInstantlyClient();
  try {
    await client.updateCampaign(campaignId, { sequences: seqs });
    await audit("ok", { step: key, subject: step?.subject, sent: step?.sent });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await audit("error", { step: key }, msg);
    throw new SequenceActionError(`Instantly refused: ${msg}`, 502);
  }
  // Rewrite this campaign's cached sequence the way the sync does, so the read view is current at once.
  const fresh = ((await client.getCampaign(campaignId)).sequences ?? []) as InSeq;
  const teamRows: Record<string, unknown>[] = [];
  (fresh[0]?.steps ?? []).forEach((st, si) => {
    const list = st.variants?.length ? st.variants : [{ subject: "", body: "" }];
    list.forEach((v, vi) => teamRows.push({
      campaign_id: campaignId, team_id: teamId, step_order: si + 1, variant_index: vi, is_variant: vi > 0,
      email_subject: v.subject ?? null, email_body: v.body ?? null,
      wait_in_days: st.delay_unit === "hours" ? Math.round((st.delay ?? 0) / 24) : st.delay_unit === "minutes" ? 0 : (st.delay ?? 0),
      synced_at: new Date().toISOString(),
    }));
  });
  await sb.from("instantly_sequence_steps").delete().eq("team_id", teamId).eq("campaign_id", campaignId);
  if (teamRows.length) await sb.from("instantly_sequence_steps").insert(teamRows);
  return liveSequence(platform, campaignId);
}
