import { randomUUID } from "node:crypto";
import { createEmailBisonClient } from "@/lib/emailbison/client.ts";
import { describeEmailBisonError } from "@/lib/emailbison/errors.ts";
import { getSupabase } from "@/lib/supabase/server";
import { attachLeads } from "./lead-membership.ts";

/*
 * Duplicate a campaign and re-sequence the people who never answered.
 *
 * EmailBison's own duplicate copies the SEQUENCE and nothing else — verified:
 * duplicating a campaign with 2 leads and 536 inboxes produced a draft with the
 * 4 steps, 0 leads and 0 inboxes. That is the gap this closes.
 *
 * THE NEW CAMPAIGN IS LEFT AS A DRAFT, DELIBERATELY. Everything here is
 * reversible while it is a draft: a wrong lead set can be removed, wrong
 * inboxes detached, the whole campaign deleted. The moment it is resumed it
 * starts emailing thousands of real people. Starting it is a separate,
 * confirmed decision that already exists on the Campaigns page, and this does
 * not make it for you.
 *
 * COPY, NOT MOVE. The leads stay on the source campaign. Removing them would
 * delete that campaign's history for them — its sends, opens and replies all
 * read from the same membership — and they are already sequence-finished there,
 * so leaving them costs nothing and preserves the record.
 */

/**
 * The statuses that mean "never answered".
 *
 * `completed` finished the sequence in silence; `contacted` is mid-sequence and
 * has not replied yet. The other three — replied, positive, bounced — are
 * exactly who must NOT be mailed again, which is why this is expressed as the
 * same derived status the Leads tab shows rather than a second definition of
 * "unresponsive" that could drift from it.
 *
 * Verified on campaign 55: 5,982 unresponsive + 288 replied/positive + 18
 * bounced = 6,288, the whole campaign.
 */
export const UNRESPONSIVE_STATUSES = ["completed", "contacted"] as const;

export interface ReCampaignResult {
  ok: boolean;
  batchId: string;
  /** The new campaign, if it got that far. */
  campaignId: number | null;
  name: string;
  /** Sequence steps EmailBison copied. */
  steps: number;
  inboxes: number;
  leadsSelected: number;
  /** Verified against the campaign's own count, not the ids we sent. */
  leadsAttached: number;
  /** Selected but not accepted — bounced or blocked leads EmailBison refuses. */
  leadsSkipped: number;
  stage: "duplicated" | "renamed" | "inboxes" | "leads" | "done";
  /** True when nothing attached and the empty duplicate was deleted again. */
  rolledBack?: boolean;
  error?: string;
}

export async function reCampaign(
  sourceCampaignId: number,
  name: string,
  options: { copyInboxes: boolean; statuses?: string[] },
  actor: string,
  teamId: number,
): Promise<ReCampaignResult> {
  const sb = getSupabase();
  const eb = createEmailBisonClient();
  const batchId = randomUUID();

  const result: ReCampaignResult = {
    ok: false,
    batchId,
    campaignId: null,
    name,
    steps: 0,
    inboxes: 0,
    leadsSelected: 0,
    leadsAttached: 0,
    leadsSkipped: 0,
    stage: "duplicated",
  };

  const fail = async (stage: ReCampaignResult["stage"], error: unknown) => {
    result.stage = stage;
    result.error = describeEmailBisonError(error);
    await audit();
    return result;
  };

  const audit = async () => {
    const { data: source } = await sb
      .from("campaigns")
      .select("name")
      .eq("id", sourceCampaignId)
      .maybeSingle();
    await sb.from("campaign_audit_log").insert({
      team_id: teamId,
      campaign_id: result.campaignId ?? sourceCampaignId,
      campaign_name: result.campaignId ? name : (source?.name ?? `#${sourceCampaignId}`),
      action: "re-campaign",
      actor,
      status: result.ok ? "ok" : "error",
      error: result.error ?? null,
      before_state: {
        source_campaign_id: sourceCampaignId,
        source_name: source?.name ?? null,
        leads_selected: result.leadsSelected,
      },
      after_state: {
        campaign_id: result.campaignId,
        steps: result.steps,
        inboxes: result.inboxes,
        leads_attached: result.leadsAttached,
        stage: result.stage,
      },
      batch_id: batchId,
    });
  };

  /*
   * The lead selection comes FIRST, before anything is created.
   *
   * If there is nobody to re-sequence, the right outcome is to say so — not to
   * leave an empty duplicate behind for someone to find and wonder about.
   */
  const { data: ids, error: idsError } = await sb.rpc("analytics_recampaign_lead_ids", {
    p_team_id: teamId,
    p_campaign_id: sourceCampaignId,
  });
  if (idsError) return fail("duplicated", new Error(idsError.message));

  const leadIds = (ids ?? []) as number[];
  result.leadsSelected = leadIds.length;
  if (!leadIds.length) {
    result.error =
      "Nobody on this campaign is free to re-sequence. Leads who never replied are " +
      "either still being emailed by another campaign, or have bounced or unsubscribed.";
    return result;
  }

  // 1. Duplicate: this is what carries the sequence across.
  let created: number;
  try {
    const response = await eb.duplicateCampaign(sourceCampaignId);
    created = Number(response?.data?.id);
    if (!Number.isInteger(created) || created <= 0) {
      throw new Error("EmailBison did not return a new campaign id");
    }
  } catch (error) {
    return fail("duplicated", error);
  }
  result.campaignId = created;

  // 2. Name it. A workspace full of "Copy of …" is unusable, and the name is
  //    also how campaign→client attribution is derived (rule 9).
  result.stage = "renamed";
  try {
    await eb.updateCampaign(created, { name });
  } catch (error) {
    return fail("renamed", error);
  }

  try {
    const steps = await eb.getCampaignSequenceSteps(created);
    result.steps = steps?.data?.sequence_steps?.length ?? 0;
  } catch {
    // Cosmetic only — the duplicate either carried the sequence or it did not,
    // and failing the whole operation over a count would be worse than
    // reporting the count as unknown.
  }

  // 3. Inboxes. A campaign with none cannot send, so this is offered rather
  //    than assumed — the source's pool is the sensible default.
  if (options.copyInboxes) {
    result.stage = "inboxes";
    try {
      const senders = await eb.getCampaignSenderEmails(sourceCampaignId);
      const senderIds = senders.map((s) => s.id).filter(Boolean);
      for (let i = 0; i < senderIds.length; i += 250) {
        await eb.attachSenderEmails(created, senderIds.slice(i, i + 250));
      }
      result.inboxes = senderIds.length;
    } catch (error) {
      return fail("inboxes", error);
    }
  }

  // 4. The leads. attachLeads verifies against the campaign's own count, which
  //    is the only honest measure — EmailBison silently drops leads it will not
  //    accept while answering success.
  result.stage = "leads";
  const membership = await attachLeads(created, leadIds, actor, teamId, {
    source_campaign_id: sourceCampaignId,
  });
  result.leadsAttached = membership.applied;
  result.leadsSkipped = membership.skipped;

  /*
   * NOTHING LANDED — ROLL THE CAMPAIGN BACK.
   *
   * A duplicate with a sequence, inboxes and no leads is worse than nothing: it
   * looks like a campaign, it is one click from being resumed, and resuming it
   * would do exactly nothing while appearing to work. Deleting it is safe
   * precisely because it is empty — there is no history to lose and the source
   * is untouched.
   *
   * EmailBison refuses a lead that is currently being emailed by another
   * sequence, and one that has bounced or unsubscribed. Verified: leads
   * `in_sequence` elsewhere are refused, leads `sequence_finished` everywhere
   * are accepted. So an all-skipped result usually means the source campaign is
   * still actively sending to these people — which is a reason not to
   * re-sequence them yet, not a bug.
   */
  if (result.leadsAttached === 0) {
    try {
      await eb.deleteCampaign(created);
      result.campaignId = null;
      result.rolledBack = true;
    } catch {
      // Could not remove it. Keep the id so the caller can finish the job by
      // hand rather than being told about a campaign they cannot find.
      result.rolledBack = false;
    }
    result.stage = "leads";
    result.error =
      membership.chunks.find((c) => !c.ok)?.error ??
      "None of the selected leads could be added. EmailBison refuses leads that are " +
        "still being emailed by another sequence, or that have bounced or unsubscribed.";
    await audit();
    return result;
  }

  result.ok = true;
  result.stage = "done";
  await audit();
  return result;
}
