import { randomUUID } from "node:crypto";

import { createEmailBisonClient } from "@/lib/emailbison/client.ts";
import { createInstantlyClient } from "@/lib/instantly/client.ts";
import { getSupabase } from "@/lib/supabase/server";

import { removeLeads } from "./lead-membership.ts";
import { UNSUPPORTED_INSTANTLY_ESP, isUnsupportedInstantly, unsupportedTagIds } from "./mail-servers.ts";

/*
 * REMOVE UNSUPPORTED MAIL SERVERS (1 Oct): take every lead whose mail server
 * is Proofpoint, Mimecast, Barracuda, Zoho or a custom server off a campaign.
 * The rules, and how they were verified per platform, are in mail-servers.ts.
 *
 * The leads are found at the moment of the action — never from a list the
 * screen held — and removed from THIS campaign only (the lead records stay).
 */

export type Platform = "emailbison" | "instantly";

export interface UnsupportedFind {
  total: number;
  byServer: { server: string; count: number }[];
  /** Tags the workspace does not have (EmailBison) — reported, never guessed. */
  missing: string[];
}

async function findEmailBison(campaignId: number): Promise<UnsupportedFind & { ids: number[] }> {
  const eb = createEmailBisonClient();
  const { found, missing } = unsupportedTagIds(await eb.listTags());
  const ids = new Set<number>();
  const byServer: { server: string; count: number }[] = [];
  for (const t of found) {
    const got = await eb.campaignLeadIdsWithTag(campaignId, t.id);
    byServer.push({ server: t.name, count: got.length });
    for (const id of got) ids.add(id);
  }
  return { total: ids.size, byServer, missing, ids: [...ids] };
}

async function findInstantly(campaignId: string): Promise<UnsupportedFind & { ids: string[] }> {
  const leads = await createInstantlyClient().walkCampaignLeads(campaignId);
  const hits = leads.filter((l) => isUnsupportedInstantly(l.esp_code));
  const byServer = Object.entries(UNSUPPORTED_INSTANTLY_ESP).map(([code, server]) => ({
    server, count: hits.filter((l) => String(l.esp_code) === code).length,
  }));
  return { total: hits.length, byServer, missing: [], ids: hits.map((l) => l.id) };
}

export async function findUnsupported(platform: Platform, campaignId: string): Promise<UnsupportedFind> {
  const { ids: _ids, ...rest } = platform === "emailbison" ? await findEmailBison(Number(campaignId)) : await findInstantly(campaignId);
  return rest;
}

export interface UnsupportedRemoval extends UnsupportedFind {
  ok: boolean;
  removed: number;
  /** Unsupported leads still on the campaign afterwards, counted again from the platform. */
  remaining: number;
  error?: string;
}

export async function removeUnsupported(platform: Platform, campaignId: string, actor: string, teamId: number): Promise<UnsupportedRemoval> {
  if (platform === "emailbison") {
    const found = await findEmailBison(Number(campaignId));
    const { ids, ...summary } = found;
    if (!ids.length) return { ...summary, ok: true, removed: 0, remaining: 0 };
    // The existing, audited path: chunked, one retry for stale ids, measured
    // against the campaign's own lead count.
    const r = await removeLeads(Number(campaignId), ids, actor, teamId);
    const after = await findEmailBison(Number(campaignId));
    return {
      ...summary, ok: r.ok && after.total === 0, removed: r.applied, remaining: after.total,
      error: r.ok ? (after.total ? `${after.total} unsupported lead(s) are still on the campaign.` : undefined)
        : r.chunks.find((c) => !c.ok)?.error ?? "EmailBison refused part of the removal.",
    };
  }

  const found = await findInstantly(campaignId);
  const { ids, ...summary } = found;
  if (!ids.length) return { ...summary, ok: true, removed: 0, remaining: 0 };
  const client = createInstantlyClient();
  const errors: string[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    try { await client.removeLeads(campaignId, ids.slice(i, i + 500)); } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
  }
  // Instantly's list is eventually consistent after a delete: count again,
  // briefly, rather than trusting the request.
  let remaining = ids.length;
  for (let tries = 0; tries < 6; tries++) {
    remaining = (await findInstantly(campaignId)).total;
    if (remaining === 0) break;
    await new Promise((r) => setTimeout(r, 2500));
  }
  const sb = getSupabase();
  for (let i = 0; i < ids.length; i += 500) {
    await sb.from("instantly_leads").delete().in("id", ids.slice(i, i + 500)).eq("team_id", teamId);
  }
  const removed = Math.max(0, ids.length - remaining);
  const ok = !errors.length && remaining === 0;
  await sb.from("campaign_audit_log").insert({
    team_id: teamId, campaign_id: null, platform: "instantly", campaign_ref: campaignId,
    action: "remove-unsupported-mail-servers", actor, status: ok ? "ok" : "error",
    error: errors[0] ?? (remaining ? `${remaining} still on the campaign` : null),
    before_state: { found: ids.length, byServer: summary.byServer }, after_state: { removed, remaining },
    batch_id: randomUUID(),
  });
  return { ...summary, ok, removed, remaining, error: errors[0] ?? (remaining ? `${remaining} unsupported lead(s) are still on the campaign.` : undefined) };
}
