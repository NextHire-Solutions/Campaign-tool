import { randomUUID } from "node:crypto";
import { createEmailBisonClient } from "@/lib/emailbison/client.ts";
import { describeEmailBisonError } from "@/lib/emailbison/errors.ts";
import { getSupabase } from "@/lib/supabase/server";
import { renderName } from "./fan-out-name.ts";

/*
 * One template campaign → one real campaign per client.
 *
 * Set a campaign up once, pick five clients, get five campaigns: each with the
 * sequence copied, its inboxes attached, and its own name. It replaces building
 * the same thing five times by hand.
 *
 * WHY NOT ONE CAMPAIGN SHARED BY FIVE CLIENTS. Because the arithmetic breaks.
 * campaign_clients is keyed one client per campaign, and every client number in
 * the product — the KPI band, the Clients table, Attribution — is a rollup over
 * the campaigns belonging to that client. A campaign counted under five clients
 * would make the Clients table sum to five times the band, and splitting its
 * sends between them needs a rule nobody has. One campaign per client keeps
 * every existing number correct and costs only that there are five to manage.
 *
 * LEADS ARE NOT COPIED, DELIBERATELY. The whole point is that these campaigns
 * go to DIFFERENT audiences — that is what makes them different clients. Copying
 * the template's leads would mail one client's list under another's name, which
 * is the worst thing this feature could do. They land empty, ready for leads.
 */

export interface FanOutTarget {
  clientId: string;
  clientName: string;
  ok: boolean;
  campaignId: number | null;
  name: string;
  steps: number;
  inboxes: number;
  error?: string;
}

export interface FanOutSummary {
  batchId: string;
  created: number;
  failed: number;
  targets: FanOutTarget[];
}

export async function fanOutToClients(
  sourceCampaignId: number,
  clientIds: string[],
  nameTemplate: string,
  options: { copyInboxes: boolean },
  actor: string,
  teamId: number,
): Promise<FanOutSummary> {
  const sb = getSupabase();
  const eb = createEmailBisonClient();
  const batchId = randomUUID();

  const { data: clientRows } = await sb
    .from("clients")
    .select("id, name")
    .eq("team_id", teamId)
    .in("id", clientIds);
  const clients = (clientRows ?? []) as Array<{ id: string; name: string }>;

  /*
   * The source's inboxes are read ONCE and reused for every target. Reading
   * them per client would be ~45 pages each, and they cannot change midway.
   */
  let senderIds: number[] = [];
  if (options.copyInboxes) {
    const senders = await eb.getCampaignSenderEmails(sourceCampaignId);
    senderIds = senders.map((s) => s.id).filter(Boolean);
  }

  const summary: FanOutSummary = { batchId, created: 0, failed: 0, targets: [] };
  const auditRows: Record<string, unknown>[] = [];
  const mappings: Record<string, unknown>[] = [];

  /*
   * SERIAL. Each target is a duplicate, a rename and up to three inbox writes
   * against the same workspace; running them at once trades a few seconds for
   * several half-built campaigns when the API starts refusing.
   */
  for (const client of clients) {
    const name = renderName(nameTemplate, client.name);
    const target: FanOutTarget = {
      clientId: client.id,
      clientName: client.name,
      ok: false,
      campaignId: null,
      name,
      steps: 0,
      inboxes: 0,
    };

    try {
      const response = await eb.duplicateCampaign(sourceCampaignId);
      const created = Number(response?.data?.id);
      if (!Number.isInteger(created) || created <= 0) {
        throw new Error("EmailBison did not return a new campaign id");
      }
      target.campaignId = created;

      await eb.updateCampaign(created, { name });

      try {
        const steps = await eb.getCampaignSequenceSteps(created);
        target.steps = steps?.data?.sequence_steps?.length ?? 0;
      } catch {
        // Cosmetic. The duplicate either carried the sequence or it did not,
        // and failing a built campaign over a count would be worse.
      }

      if (senderIds.length) {
        for (let i = 0; i < senderIds.length; i += 250) {
          await eb.attachSenderEmails(created, senderIds.slice(i, i + 250));
        }
        target.inboxes = senderIds.length;
      }

      target.ok = true;
      summary.created++;

      /*
       * PINNED AS `manual`. Attribution is normally derived by matching the
       * client's name inside the campaign's name, and sync-clients recomputes
       * every `auto` row on each run. A human picked this client explicitly, so
       * it is pinned — the sync skips manual rows — and the campaign cannot
       * drift to a different client because someone edited its name later.
       */
      mappings.push({
        campaign_id: created,
        client_id: client.id,
        match_method: "manual",
        matched_on: "fan-out",
        confidence: 1,
        ambiguous: false,
        excluded: false,
        exclude_reason: null,
        resolved_at: new Date().toISOString(),
      });
    } catch (error) {
      target.error = describeEmailBisonError(error);
      summary.failed++;
      // Keep going. One client failing says nothing about the next, and
      // stopping would turn one bad target into four unattempted ones.
    }

    summary.targets.push(target);
    auditRows.push({
      team_id: teamId,
      campaign_id: target.campaignId ?? sourceCampaignId,
      campaign_name: name,
      action: "fan-out",
      actor,
      status: target.ok ? "ok" : "error",
      error: target.error ?? null,
      before_state: { source_campaign_id: sourceCampaignId, client: client.name },
      after_state: target.ok
        ? { campaign_id: target.campaignId, steps: target.steps, inboxes: target.inboxes }
        : null,
      batch_id: batchId,
    });
  }

  /*
   * ORDER MATTERS, AND IT BIT.
   *
   * campaign_clients.campaign_id is a FOREIGN KEY to campaigns(id). Writing the
   * mapping alongside the audit rows, before the campaign was cached, meant
   * every mapping failed the constraint — and because the result was never
   * checked, it failed in total silence: the campaigns appeared, the audit was
   * written, and not one of them was attributed to the client that had just
   * been chosen for it. They would have shown as Unassigned.
   *
   * So: cache the campaigns first, then map them, and CHECK BOTH.
   */
  const createdRows = summary.targets
    .filter((t) => t.ok && t.campaignId)
    .map((t) => ({
      id: t.campaignId as number,
      team_id: teamId,
      name: t.name,
      status: "draft",
      synced_at: new Date().toISOString(),
    }));

  if (createdRows.length) {
    const { error } = await sb.from("campaigns").upsert(createdRows, { onConflict: "id" });
    if (error) throw new Error(`caching new campaigns: ${error.message}`);
  }

  if (mappings.length) {
    const { error } = await sb
      .from("campaign_clients")
      .upsert(mappings, { onConflict: "campaign_id" });
    /*
     * Not fatal to the campaigns — they exist in EmailBison either way, and
     * throwing here would lose the ids the caller needs. Reported per target
     * instead, so the screen cannot claim an attribution that was not written.
     */
    if (error) {
      for (const t of summary.targets) {
        if (t.ok) t.error = `Created, but not linked to the client: ${error.message}`;
      }
    }
  }

  if (auditRows.length) await sb.from("campaign_audit_log").insert(auditRows);

  return summary;
}
