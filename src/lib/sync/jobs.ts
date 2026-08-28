import { createEmailBisonClient, type EmailBisonClient } from "@/lib/emailbison/client.ts";
import { classifyPlatform } from "../analytics/outcomes.ts";
import { normaliseAttributeName, parseNumericValue } from "../analytics/lead-attributes.ts";

/*
 * Attributes a numeric band is actually computed from.
 *
 * Everything else on a lead is text by design — "office city" is "Charlotte, NC"
 * and failing to parse it is correct, not a fault. Counting those as parse
 * failures made the first run report 1,836 of 5,568 "unparsed", which reads as
 * a broken importer instead of a working one.
 */
const NUMERIC_LEAD_ATTRIBUTES = new Set([
  "sales volume",
  "estimated gci",
  "closed transactions",
  "average sales price",
  "closed rentals",
  "buy-side",
  "list-side",
]);
import { dedupeBy } from "./dedupe.ts";
import { getSupabase } from "@/lib/supabase/server";
import { exclusionReason, matchCampaign } from "@/lib/clients/match.ts";
import type { JobFn, JobResult } from "./runner";

/*
 * The sync jobs, shared by the cron routes.
 *
 * Every one is IDEMPOTENT: re-running writes the same rows. That is what makes
 * a missed window a non-event — there is no delivery guarantee to preserve,
 * only a cursor to advance. It's also why this app has no webhook endpoint.
 */

const slugify = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const isoDaysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) await worker(items[cursor++]);
    }),
  );
}

async function chunkUpsert(
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
  size = 500,
) {
  const sb = getSupabase();
  // Dedupe first: Postgres fails the whole statement if ON CONFLICT touches a
  // row twice, and EmailBison's offset pagination repeats rows. See dedupe.ts.
  const unique = dedupeBy(rows, onConflict);
  if (unique.length !== rows.length) {
    console.warn(
      `[sync] ${table}: dropped ${rows.length - unique.length} duplicate rows before upsert`,
    );
  }
  for (let i = 0; i < unique.length; i += size) {
    const { error } = await sb.from(table).upsert(unique.slice(i, i + size), { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

async function scopedCampaigns(teamId: number) {
  const { data } = await getSupabase()
    .from("campaigns")
    .select("id, name, eb_updated_at")
    .eq("team_id", teamId);
  return data ?? [];
}

// --- entities: campaigns, clients, and the campaign→client mapping ----------

export const syncEntities: JobFn = async ({ teamId }): Promise<JobResult> => {
  const eb = createEmailBisonClient();
  const sb = getSupabase();
  let apiCalls = 0;

  const campaigns = await eb.getAllCampaigns();
  apiCalls += Math.ceil(campaigns.length / 100) + 1;

  await sb.from("teams").upsert(
    { id: teamId, name: "BrokerStaffer's Team", timezone: "America/New_York" },
    { onConflict: "id" },
  );

  await chunkUpsert(
    "campaigns",
    campaigns.map((c) => ({
      id: c.id,
      team_id: teamId,
      name: c.name,
      type: c.type ?? null,
      status: c.status ?? null,
      tags: c.tags ?? [],
      max_emails_per_day: c.max_emails_per_day ?? null,
      total_leads: c.total_leads ?? null,
      lifetime_emails_sent: c.emails_sent ?? null,
      eb_created_at: c.created_at ?? null,
      eb_updated_at: c.updated_at ?? null,
      // Settings and the lifetime funnel arrive on the same list response, so
      // caching them is free and turns the detail page into one indexed read.
      sequence_id: c.sequence_id ?? null,
      max_new_leads_per_day: c.max_new_leads_per_day ?? null,
      plain_text: c.plain_text ?? null,
      open_tracking: c.open_tracking ?? null,
      can_unsubscribe: c.can_unsubscribe ?? null,
      unsubscribe_text: c.unsubscribe_text ?? null,
      include_auto_replies_in_stats: c.include_auto_replies_in_stats ?? null,
      sequence_prioritization: c.sequence_prioritization ?? null,
      completion_percentage: c.completion_percentage ?? null,
      // Cumulative counters. Overview shows them as lifetime totals and says
      // so — never use them for anything date-ranged.
      lifetime_opened: c.opened ?? null,
      lifetime_unique_opens: c.unique_opens ?? null,
      lifetime_replied: c.replied ?? null,
      lifetime_unique_replies: c.unique_replies ?? null,
      lifetime_bounced: c.bounced ?? null,
      lifetime_unsubscribed: c.unsubscribed ?? null,
      lifetime_interested: c.interested ?? null,
      total_leads_contacted: c.total_leads_contacted ?? null,
      synced_at: new Date().toISOString(),
    })),
    "id",
  );

  // Refresh the client roster from the portal before matching, so a client
  // added there is usable here on the next tick. Best-effort: if the portal is
  // down we still match against the clients already stored, rather than
  // unassigning every campaign.
  const portalBase = (process.env.PORTAL_BASE_URL ?? "").replace(/\/$/, "");
  const portalToken = process.env.PORTAL_TOKEN;
  let portalClients = 0;

  if (portalBase && portalToken) {
    try {
      const response = await fetch(
        `${portalBase}/api/clients/portals?token=${portalToken}`,
        { cache: "no-store", headers: { Accept: "application/json" } },
      );
      apiCalls++;
      const type = response.headers.get("content-type") ?? "";
      // That host rewrites blocked /api/* to an HTML page with status 200, so
      // `ok` alone would happily parse a login page as the client list.
      if (response.ok && type.includes("application/json")) {
        const body = await response.json();
        const source: Array<{ id?: string; name: string; slug?: string; aliases?: string[] }> =
          body.clients ?? [];
        if (source.length) {
          // Aliases are edited locally on /clients and are NOT in the portal
          // payload, so they are omitted from the upsert — writing `[]` here
          // would wipe every alias on every tick.
          const { error } = await sb.from("clients").upsert(
            source.map((c) => ({
              team_id: teamId,
              name: c.name,
              slug: c.slug || slugify(c.name),
              // MasterInbox's own id. Every join between the two systems used to
              // be by name, so a rename there would silently have become a
              // second client here — and the outcomes feed names its client by
              // id, which is the join that has to be rename-proof.
              portal_client_id: c.id ?? null,
            })),
            { onConflict: "team_id,slug" },
          );
          if (!error) portalClients = source.length;
        }
      }
    } catch {
      /* portal unavailable — fall through to the stored roster */
    }
  }

  const { data: clientDetail } = await sb
    .from("clients")
    .select("id, name, aliases, match_mode")
    .eq("team_id", teamId);

  const matchable = (clientDetail ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    aliases: c.aliases ?? [],
    matchMode: c.match_mode as "contains" | "prefix" | "exact",
  }));

  // Manual pins are never recomputed — a human decided those.
  const { data: pinned } = await sb
    .from("campaign_clients")
    .select("campaign_id")
    .eq("match_method", "manual");
  const pinnedIds = new Set((pinned ?? []).map((p) => p.campaign_id));

  const mappings = campaigns
    .filter((c) => !pinnedIds.has(c.id))
    .map((c) => {
      const reason = exclusionReason(c.name);
      if (reason) {
        return {
          campaign_id: c.id,
          client_id: null,
          match_method: "auto",
          matched_on: null,
          confidence: null,
          ambiguous: false,
          excluded: true,
          exclude_reason: reason,
          resolved_at: new Date().toISOString(),
        };
      }
      const result = matchCampaign(c.name, matchable);
      return {
        campaign_id: c.id,
        client_id: result.clientId,
        match_method: "auto",
        matched_on: result.matchedOn,
        confidence: result.confidence,
        ambiguous: result.ambiguous,
        excluded: false,
        exclude_reason: null,
        resolved_at: new Date().toISOString(),
      };
    });

  await chunkUpsert("campaign_clients", mappings, "campaign_id");

  /*
   * Reconcile removals. Upserting alone meant a campaign deleted in EmailBison
   * lived on in the cache forever — still in the picker, still selectable as a
   * copy target.
   *
   * Soft, because campaigns is the parent of the day-stats, step-stats,
   * sequence-steps and client-mapping tables with ON DELETE CASCADE: dropping
   * the row would erase that campaign's history from every chart. The sends
   * happened.
   *
   * And reversible, because EmailBison deletes asynchronously ("queued for
   * deletion") — a campaign can briefly vanish and come back, and a one-way
   * flag would permanently hide a live campaign over a transient blip.
   */
  const liveIds = campaigns.map((c) => c.id);
  const [gone, back] = await Promise.all([
    sb
      .from("campaigns")
      .update({ deleted_at: new Date().toISOString() })
      .eq("team_id", teamId)
      .is("deleted_at", null)
      .not("id", "in", `(${liveIds.join(",")})`)
      .select("id"),
    sb
      .from("campaigns")
      .update({ deleted_at: null })
      .eq("team_id", teamId)
      .not("deleted_at", "is", null)
      .in("id", liveIds)
      .select("id"),
  ]);

  return {
    rowsWritten: campaigns.length + mappings.length,
    apiCalls,
    detail: {
      campaigns: campaigns.length,
      clients: matchable.length,
      portalClients,
      unassigned: mappings.filter((m) => !m.excluded && !m.client_id).length,
      excluded: mappings.filter((m) => m.excluded).length,
      markedDeleted: gone.data?.length ?? 0,
      restored: back.data?.length ?? 0,
    },
  };
};

// --- sequence steps ---------------------------------------------------------

export const syncSteps: JobFn = async ({ teamId }): Promise<JobResult> => {
  const eb = createEmailBisonClient();
  const campaigns = await scopedCampaigns(teamId);
  const rows: Record<string, unknown>[] = [];
  // Only campaigns we successfully read, so a failed fetch never looks like
  // "this campaign has no steps any more".
  const seenByCampaign = new Map<number, Set<number>>();
  let apiCalls = 0;

  await pool(campaigns, 4, async (c) => {
    try {
      const payload = await eb.getCampaignSequenceSteps(c.id);
      apiCalls++;
      seenByCampaign.set(c.id, new Set());
      for (const s of payload?.data?.sequence_steps ?? []) {
        seenByCampaign.get(c.id)!.add(s.id);
        rows.push({
          id: s.id,
          campaign_id: c.id,
          team_id: teamId,
          sequence_id: payload?.data?.sequence_id ?? null,
          step_order: Number(s.order) || null,
          email_subject: s.email_subject ?? null,
          email_body: s.email_body ?? null,
          wait_in_days: Number(s.wait_in_days) || null,
          is_variant: Boolean(s.variant),
          variant_from_step_id: s.variant_from_step_id ?? null,
          thread_reply: Boolean(s.thread_reply),
          attachments: s.attachments ?? [],
          synced_at: new Date().toISOString(),
        });
      }
    } catch {
      // Draft campaigns have no sequence and 400. One bad campaign must not
      // abort the sweep.
    }
  });

  await chunkUpsert("sequence_steps", rows, "id");

  /*
   * Reconcile removals, per campaign.
   *
   * Upserting alone meant a step deleted in EmailBison — by the sequence
   * editor, or by a Replace copy — lived on in the cache forever. The
   * Campaigns table renders its step rows from here, so a replaced sequence
   * showed the old steps beside the new ones and the step counts never went
   * down. Found on the OpsLabs test campaign: 7 cached steps for a 4-step
   * sequence.
   *
   * A hard delete, unlike campaigns, which are soft-deleted because they are
   * the parent of the day-stats and reply tables. A step that no longer exists
   * upstream has nothing hanging off it but its copy tags, and those are
   * ON DELETE CASCADE precisely because a tag for a deleted email is noise.
   *
   * Scoped to campaigns this run actually READ. A campaign whose fetch failed
   * contributes no ids, and wiping its steps because we could not see them
   * would turn one bad request into data loss.
   */
  let removed = 0;
  for (const [campaignId, keepIds] of seenByCampaign) {
    const { data: stale } = await getSupabase()
      .from("sequence_steps")
      .select("id")
      .eq("campaign_id", campaignId)
      .not("id", "in", `(${[...keepIds].join(",") || "0"})`);

    if (stale?.length) {
      await getSupabase()
        .from("sequence_steps")
        .delete()
        .in("id", stale.map((r) => r.id));
      removed += stale.length;
    }
  }

  return { rowsWritten: rows.length, apiCalls, detail: { steps: rows.length, removed } };
};

// --- daily series -----------------------------------------------------------

const METRIC_BY_LABEL: Record<string, string> = {
  Sent: "sent",
  Replied: "replies",
  Bounced: "bounces",
  Unsubscribed: "unsubscribes",
  Interested: "positive",
  "Total Opens": "opens_total",
  "Unique Opens": "opens_unique",
};

async function collectSeries(
  eb: EmailBisonClient,
  path: string,
  from: string,
  to: string,
  campaignId: number,
  teamId: number,
  out: Record<string, unknown>[],
  unmapped: Set<string>,
) {
  const payload = await eb.getDailySeries(
    path,
    new URLSearchParams({ start_date: from, end_date: to }),
  );
  for (const series of payload?.data ?? []) {
    const metric = METRIC_BY_LABEL[series.label];
    if (!metric) {
      unmapped.add(series.label);
      continue;
    }
    for (const [date, value] of series.dates ?? []) {
      if (typeof date !== "string" || !Number.isFinite(Number(value))) continue;
      out.push({
        team_id: teamId,
        campaign_id: campaignId,
        stat_date: date,
        metric,
        value: Number(value),
      });
    }
  }
}

/** Each call returns the WHOLE range, so a wide window costs no more than a narrow one. */
export function makeDailySeriesJob(days: number): JobFn {
  return async ({ teamId }): Promise<JobResult> => {
    const eb = createEmailBisonClient();
    const to = isoDaysAgo(0);
    const from = isoDaysAgo(days - 1);
    const rows: Record<string, unknown>[] = [];
    const unmapped = new Set<string>();
    let apiCalls = 0;

    await collectSeries(
      eb, "/api/workspaces/v1.1/line-area-chart-stats", from, to, 0, teamId, rows, unmapped,
    );
    apiCalls++;

    const campaigns = await scopedCampaigns(teamId);
    await pool(campaigns, 4, async (c) => {
      try {
        await collectSeries(
          eb, `/api/campaigns/${c.id}/line-area-chart-stats`, from, to, c.id, teamId, rows, unmapped,
        );
        apiCalls++;
      } catch {
        /* one campaign failing must not abort the sweep */
      }
    });

    if (unmapped.size) {
      // The drift detector: EmailBison adding a series shows up here, not as a
      // number that quietly stops adding up.
      console.warn(`[cron] unmapped daily-series labels: ${[...unmapped].join(", ")}`);
    }

    await chunkUpsert("eb_daily_series", rows, "team_id,campaign_id,stat_date,metric", 1000);
    return { rowsWritten: rows.length, apiCalls, detail: { from, to } };
  };
}

// --- day + step stats (one call fills both tables) ---------------------------

export function makeDayStatsJob(days: number): JobFn {
  return async ({ teamId }): Promise<JobResult> => {
    const eb = createEmailBisonClient();
    const campaigns = await scopedCampaigns(teamId);
    const dates = Array.from({ length: days }, (_, i) => isoDaysAgo(i));

    const dayRows: Record<string, unknown>[] = [];
    const stepRows: Record<string, unknown>[] = [];
    let apiCalls = 0;

    const jobs = campaigns.flatMap((c) => dates.map((d) => ({ c, d })));

    await pool(jobs, 4, async ({ c, d }) => {
      try {
        const payload = await eb.getCampaignStats(c.id, d, d);
        apiCalls++;
        const s = payload?.data ?? {};
        const n = (v: unknown) => Number(v ?? 0) || 0;

        // Skip empty days: writing thousands of all-zero rows would make "no
        // data" indistinguishable from "genuinely zero sends".
        if (n(s.emails_sent) === 0 && n(s.total_leads_contacted) === 0) return;

        dayRows.push({
          campaign_id: c.id, team_id: teamId, stat_date: d,
          emails_sent: n(s.emails_sent),
          total_leads_contacted: n(s.total_leads_contacted),
          opened: n(s.opened),
          unique_opens: n(s.unique_opens_per_contact),
          unique_replies: n(s.unique_replies_per_contact),
          bounced: n(s.bounced),
          unsubscribed: n(s.unsubscribed),
          interested: n(s.interested),
        });

        for (const step of s.sequence_step_stats ?? []) {
          stepRows.push({
            campaign_id: c.id, team_id: teamId,
            sequence_step_id: step.sequence_step_id, stat_date: d,
            email_subject: step.email_subject ?? null,
            sent: n(step.sent), leads_contacted: n(step.leads_contacted),
            unique_opens: n(step.unique_opens), unique_replies: n(step.unique_replies),
            unsubscribed: n(step.unsubscribed), bounced: n(step.bounced),
            interested: n(step.interested),
          });
        }
      } catch {
        /* drafts 400; skip */
      }
    });

    await chunkUpsert("campaign_day_stats", dayRows, "campaign_id,stat_date");
    await chunkUpsert(
      "campaign_step_stats_daily", stepRows, "campaign_id,sequence_step_id,stat_date",
    );

    return {
      rowsWritten: dayRows.length + stepRows.length,
      apiCalls,
      detail: { days, dayRows: dayRows.length, stepRows: stepRows.length },
    };
  };
}

// --- replies ----------------------------------------------------------------

/*
 * Replies come from /api/campaigns/{id}/replies, NOT /api/replies. The latter
 * is the master inbox: ~1.9M rows, 959K of them our own outbound, most with a
 * NULL campaign_id.
 *
 * The feed is newest-first, which is what makes the incremental mode possible:
 * `overlapHours` stops paging a campaign once a page's oldest row predates the
 * last successful run by that margin. A full walk is 600 calls and six minutes
 * — far too slow for a 10-minute cadence — while the incremental sweep is
 * usually one page per campaign.
 *
 * The 48-hour overlap is not paranoia: EmailBison backfills late deliveries,
 * and a reply that arrives dated yesterday would fall behind an exact
 * watermark and never be picked up.
 */
export function makeRepliesJob(overlapHours: number | null): JobFn {
  return async ({ teamId, watermark }): Promise<JobResult> => {
  const eb = createEmailBisonClient();
  const campaigns = await scopedCampaigns(teamId);
  const rows: Record<string, unknown>[] = [];
  const startedAt = new Date().toISOString();
  let apiCalls = 0;
  let pagesRead = 0;

  // No watermark yet (first run after deploy) => full walk, whatever the mode.
  const cutoff =
    overlapHours !== null && watermark
      ? new Date(new Date(watermark).getTime() - overlapHours * 3_600_000)
      : null;

  await pool(campaigns, 4, async (c) => {
    try {
      let cursor: string | null = null;
      for (;;) {
        const payload = await eb.getCampaignRepliesPage(c.id, cursor);
        apiCalls++;
        pagesRead++;
        const batch = payload.data ?? [];
        for (const r of batch) {
          if (r.tracked_reply === false) continue;
          if ((r.folder ?? "").toLowerCase() === "sent") continue;
          rows.push({
            id: r.id, team_id: teamId,
            campaign_id: r.campaign_id ?? c.id,
            lead_id: r.lead_id ?? null,
            sender_email_id: r.sender_email_id ?? null,
            scheduled_email_id: r.scheduled_email_id ?? null,
            parent_id: r.parent_id ?? null,
            folder: r.folder ?? null,
            subject: r.subject ?? null,
            text_body: r.text_body ?? null,
            from_email_address: r.from_email_address ?? null,
            from_name: r.from_name ?? null,
            date_received: r.date_received,
            // Always true by here — the `=== false` rows were skipped above.
            tracked_reply: r.tracked_reply ?? true,
            automated_reply: Boolean(r.automated_reply),
            interested: Boolean(r.interested),
            synced_at: new Date().toISOString(),
          });
        }
        // Newest-first, so the last row on the page is the oldest seen so far.
        // Stopping here is what makes the frequent job cheap: it walks back only
        // as far as the watermark, not through the campaign's whole history.
        const oldest = batch.length ? batch[batch.length - 1].date_received : null;
        if (cutoff && oldest && new Date(oldest) < cutoff) break;

        const next: string | null = payload.meta?.next_cursor ?? null;
        if (!next || next === cursor) break;
        cursor = next;
      }
    } catch {
      /* skip a failing campaign */
    }
  });

  // NOTE the column list: sentiment, first_send_at, first_followup_at and
  // timing_synced_at are locally owned and deliberately absent, or every sweep
  // would erase classification and timing.
  await chunkUpsert("replies", rows, "id");

  return {
    rowsWritten: rows.length,
    apiCalls,
    watermark: startedAt,
    detail: { pagesRead, mode: cutoff ? `incremental (${overlapHours}h overlap)` : "full" },
  };
  };
}

// --- sender emails (the Infrastructure tab) ---------------------------------

export const syncSenders: JobFn = async ({ teamId }): Promise<JobResult> => {
  const eb = createEmailBisonClient();
  const senders = await eb.getAllSenderEmails();

  const rows = senders.map((s) => ({
    id: s.id,
    team_id: teamId,
    email: s.email,
    name: s.name ?? null,
    // Derived here, not stored upstream — it is the whole basis of the
    // by-domain rollup, so it must be consistent for every row.
    domain: s.email?.includes("@") ? s.email.split("@").pop()!.toLowerCase() : null,
    provider: s.type ?? null,
    status: s.status ?? null,
    daily_limit: s.daily_limit ?? null,
    warmup_enabled: s.warmup_enabled ?? null,
    lifetime_sent: s.emails_sent_count ?? null,
    lifetime_bounced: s.bounced_count ?? null,
    lifetime_replied: s.total_replied_count ?? null,
    unique_replied: s.unique_replied_count ?? null,
    unique_opened: s.unique_opened_count ?? null,
    lifetime_unsubscribed: s.unsubscribed_count ?? null,
    interested_leads: s.interested_leads_count ?? null,
    leads_contacted: s.total_leads_contacted_count ?? null,
    eb_created_at: s.created_at ?? null,
    synced_at: new Date().toISOString(),
  }));

  await chunkUpsert("sender_emails", rows, "id");

  return {
    rowsWritten: rows.length,
    // 15 per page, so ~98 calls for the current estate. Cheap enough hourly,
    // and it is the only source of the Infrastructure tab's numbers.
    apiCalls: Math.ceil(rows.length / 15) + 1,
    detail: {
      senders: rows.length,
      sending: rows.filter((r) => (r.lifetime_sent ?? 0) > 0).length,
      domains: new Set(rows.map((r) => r.domain).filter(Boolean)).size,
    },
  };
};

// --- reply timing (Median Reply Time) ---------------------------------------

export const syncReplyTiming: JobFn = async ({ teamId }): Promise<JobResult> => {
  const eb = createEmailBisonClient();
  const sb = getSupabase();
  let apiCalls = 0;

  const { data: pending } = await sb
    .from("replies")
    .select("id, lead_id, campaign_id, date_received")
    .eq("team_id", teamId)
    .is("timing_synced_at", null)
    .not("lead_id", "is", null)
    // Newest first: a fresh reply's timing matters more than a three-month-old
    // one's, and the backlog drains from the useful end.
    //
    // 1000/run is ~470 lead calls and ~4 minutes, which sits comfortably inside
    // the hourly cadence. Steady state is ~120 new replies a day, so this cap
    // only governs how fast an initial backlog clears.
    .order("date_received", { ascending: false })
    .limit(1000);

  if (!pending?.length) return { rowsWritten: 0, apiCalls: 0 };

  const byLead = new Map<number, typeof pending>();
  for (const r of pending) {
    const list = byLead.get(r.lead_id!) ?? [];
    list.push(r);
    byLead.set(r.lead_id!, list);
  }

  const updates: Array<{ id: number; first_send_at: string | null }> = [];

  await pool([...byLead.keys()], 4, async (leadId) => {
    try {
      const payload = await eb.getLeadSentEmails(leadId);
      apiCalls++;
      const sends = Array.isArray(payload?.data) ? payload.data : [];

      for (const reply of byLead.get(leadId)!) {
        const candidates = sends
          .filter(
            (s) =>
              s.sent_at &&
              (reply.campaign_id == null || s.campaign_id === reply.campaign_id) &&
              new Date(String(s.sent_at)) < new Date(reply.date_received),
          )
          .sort(
            (a, b) =>
              new Date(String(a.sent_at)).getTime() - new Date(String(b.sent_at)).getTime(),
          );
        updates.push({
          id: reply.id,
          first_send_at: (candidates[0]?.sent_at as string) ?? null,
        });
      }
    } catch {
      /* lead deleted upstream */
    }
  });

  // Stamped even when no send was found, so a reply whose sends have aged out
  // isn't retried on every single tick forever.
  for (const u of updates) {
    await sb
      .from("replies")
      .update({ first_send_at: u.first_send_at, timing_synced_at: new Date().toISOString() })
      .eq("id", u.id);
  }

  return {
    rowsWritten: updates.length,
    apiCalls,
    detail: { resolved: updates.filter((u) => u.first_send_at).length },
  };
};

/*
 * `satisfies`, not a type annotation: `Record<string, JobFn>` would widen the
 * keys to `string` and silently disable the compile-time schedule check in
 * schedule.ts.
 */
// --- outcomes / attribution (spec §7) ---------------------------------------

interface OutcomeRow {
  id: string;
  email: string;
  event_type: string;
  occurred_at: string;
  updated_at?: string | null;
  voided?: boolean;
  campaign_id?: number | string | null;
  emailbison_lead_id?: number | null;
  /** MasterInbox's owning client. Present on every row since the feed added it. */
  client_id?: string | null;
  client_name?: string | null;
}

/**
 * Pulls the outcomes feed, incrementally.
 *
 * `updated_since` is driven off the watermark, so a re-run costs one page
 * instead of ten — and because the watermark only advances on success, a failed
 * run re-covers the same window rather than skipping it.
 */
export const syncOutcomes: JobFn = async ({ teamId, watermark }): Promise<JobResult> => {
  const base = (process.env.OUTCOMES_BASE_URL ?? "").replace(/\/$/, "");
  const token = process.env.OUTCOMES_TOKEN;
  if (!base || !token) {
    throw new Error("OUTCOMES_BASE_URL / OUTCOMES_TOKEN are not set");
  }

  const startedAt = new Date().toISOString();
  // Split by whether the FEED decides the attribution or the resolver does.
  const decided: Record<string, unknown>[] = [];
  const undecided: Record<string, unknown>[] = [];
  let apiCalls = 0;

  /*
   * The client lookup, by MasterInbox's id first and its name second.
   *
   * The id is the rename-proof key and covers 40 of our 41 clients; the name is
   * the fallback for a client the portal roster does not return (two exist —
   * they appear in outcomes but not in the roster). Both are loaded once rather
   * than probed per row: 2,100 rows against 41 clients.
   */
  const { data: clientRows } = await getSupabase()
    .from("clients")
    .select("id, name, slug, portal_client_id")
    .eq("team_id", teamId);
  const clientByPortalId = new Map<string, string>();
  const clientBySlug = new Map<string, string>();
  for (const c of clientRows ?? []) {
    if (c.portal_client_id) clientByPortalId.set(String(c.portal_client_id), c.id);
    clientBySlug.set(slugify(c.name), c.id);
    if (c.slug) clientBySlug.set(String(c.slug), c.id);
  }
  let clientUnmatched = 0;
  /*
   * A client the feed names that the portal roster does not return.
   *
   * Two exist ("Kelly + Co", "Young Realty") and between them own 59 outcomes.
   * They are created here rather than reported and ignored: MasterInbox is the
   * authority on who the clients are — the roster sync already creates them from
   * the same source — and an outcome whose owner we refuse to record is an
   * outcome missing from that client's totals for no defensible reason.
   */
  const newClients = new Map<string, { id: string; name: string }>();

  for (let page = 1; ; page++) {
    const query = new URLSearchParams({ page: String(page), per_page: "200" });
    // A 6h overlap absorbs clock skew and any row written while the last run
    // was mid-flight; re-fetching is free because ids are stable.
    if (watermark) {
      query.set(
        "updated_since",
        new Date(new Date(watermark).getTime() - 6 * 3600_000).toISOString(),
      );
    }

    const response = await fetch(`${base}/api/outcomes?${query}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
    });
    apiCalls++;
    if (!response.ok) {
      throw new Error(`Outcomes API ${response.status} on page ${page}`);
    }

    const body = await response.json();
    for (const o of (body.data ?? []) as OutcomeRow[]) {
      /*
       * campaign_id names THREE different things — confirmed by the person who
       * built the feed, after an earlier read of this file got it wrong:
       *
       *   integer -> an EmailBison campaign      (ours; credit it directly)
       *   UUID    -> an INSTANTLY campaign       (another sending platform)
       *   null    -> logged directly by the client, no campaign named
       *
       * Only the integer branch may ever reach resolved_campaign_id. An Instantly
       * outcome resolved through EmailBison WOULD find a lead — most of these
       * people are in both systems — and would credit one of our campaigns with a
       * result another platform earned. See 025.
       */
      const ref = o.campaign_id == null ? null : String(o.campaign_id);
      const platform = classifyPlatform(ref);
      const providedCampaign = platform === "emailbison" ? Number(ref) : null;

      /*
       * 5 of 1,923 rows arrive with no email, no lead id and no campaign — real
       * outcomes with nothing on them to attribute by. Stamped `unresolved` here
       * rather than left NULL, so the resolver's queue holds only rows it can
       * actually make progress on. They still count in the totals; see 024.
       */
      const unattributable = platform === "direct" && !o.email && !o.emailbison_lead_id;

      /*
       * The owning client, from the feed. This is ground truth and it is stored
       * verbatim as well as resolved, so a client we do not yet hold shows up as
       * a name rather than vanishing. "Unknown" is MasterInbox's own placeholder
       * for "no client", not a client.
       */
      const clientName = o.client_name && o.client_name !== "Unknown" ? o.client_name : null;
      const resolvedClient =
        (o.client_id ? clientByPortalId.get(String(o.client_id)) : undefined) ??
        (clientName ? clientBySlug.get(slugify(clientName)) : undefined) ??
        null;
      if (clientName && !resolvedClient) {
        clientUnmatched++;
        if (o.client_id) newClients.set(String(o.client_id), { id: String(o.client_id), name: clientName });
      }

      const row: Record<string, unknown> = {
        resolved_client_id: resolvedClient,
        source_client_ref: o.client_id ?? null,
        source_client_name: o.client_name ?? null,
        id: o.id,
        team_id: teamId,
        email: o.email ?? null,
        event_type: o.event_type,
        occurred_at: o.occurred_at,
        source_updated_at: o.updated_at ?? null,
        voided: Boolean(o.voided),
        source_campaign_ref: ref,
        source_platform: platform,
        source_lead_id: typeof o.emailbison_lead_id === "number" ? o.emailbison_lead_id : null,
        synced_at: new Date().toISOString(),
      };

      if (providedCampaign) {
        row.resolved_campaign_id = providedCampaign;
        row.resolution = "provided";
        row.resolved_at = new Date().toISOString();
        decided.push(row);
      } else if (platform === "instantly") {
        // Counted in every total, never credited to one of our campaigns.
        row.resolution = "other_platform";
        row.resolved_at = new Date().toISOString();
        decided.push(row);
      } else if (unattributable) {
        row.resolution = "unresolved";
        row.resolved_at = new Date().toISOString();
        decided.push(row);
      } else {
        undecided.push(row);
      }
    }

    const lastPage = Number(body.meta?.last_page) || 1;
    if (page >= lastPage) break;
    if (page >= 200) {
      console.warn("[cron] sync-outcomes: stopped at the 200-page guard");
      break;
    }
  }

  /*
   * TWO UPSERTS, AND THE SPLIT IS THE WHOLE POINT.
   *
   * `resolution` / `resolved_campaign_id` / `resolved_at` are LOCALLY OWNED for
   * a `direct` row — the resolver spent an EmailBison lookup to write them. The
   * feed has no opinion about them, so this job must not touch them.
   *
   * One mixed upsert does touch them. PostgREST builds the ON CONFLICT DO UPDATE
   * column list from the UNION of keys across the batch, so a batch holding both
   * kinds of row writes NULL into `resolution` for every row that omitted it.
   * Observed live: re-running this job reset 63 already-resolved rows to
   * pending and dropped "credited to a campaign" from 388 to 337 — the hourly
   * pair would have undone each other forever, re-spending ~800 API calls a run
   * and leaving the coverage number visibly oscillating.
   *
   * Same rule as `replies.sentiment`: a cache job never writes a column it does
   * not own.
   */
  /*
   * Register any newly-seen client BEFORE the outcome rows land, so the foreign
   * key resolves and the rows carry their owner on this run rather than the next.
   */
  if (newClients.size) {
    await chunkUpsert(
      "clients",
      [...newClients.values()].map((c) => ({
        team_id: teamId,
        name: c.name,
        slug: slugify(c.name),
        portal_client_id: c.id,
      })),
      "team_id,slug",
    );
    const { data: refreshed } = await getSupabase()
      .from("clients")
      .select("id, portal_client_id")
      .eq("team_id", teamId)
      .not("portal_client_id", "is", null);
    for (const c of refreshed ?? []) clientByPortalId.set(String(c.portal_client_id), c.id);
    for (const row of [...decided, ...undecided]) {
      if (!row.resolved_client_id && row.source_client_ref) {
        row.resolved_client_id =
          clientByPortalId.get(String(row.source_client_ref)) ?? null;
      }
    }
  }

  await chunkUpsert("outcome_events", decided, "id");
  await chunkUpsert("outcome_events", undecided, "id");


  const all = [...decided, ...undecided];
  return {
    rowsWritten: all.length,
    apiCalls,
    watermark: startedAt,
    detail: {
      outcomes: all.length,
      emailbison: all.filter((r) => r.source_platform === "emailbison").length,
      instantly: all.filter((r) => r.source_platform === "instantly").length,
      direct: all.filter((r) => r.source_platform === "direct").length,
      withClient: all.filter((r) => r.resolved_client_id).length,
      // A client the feed names that we do not hold. Visible rather than
      // silently dropped — it is fixable on the Clients page.
      clientUnmatched,
      clientsCreated: newClients.size,
    },
  };
};

/**
 * First-touch attribution (§7: "credited back to the campaign that FIRST
 * contacted that person").
 *
 * A draining work queue, like sync-reply-timing: email -> EmailBison lead ->
 * sent-emails -> earliest send -> that campaign. Sampled against the live API
 * before building this, 19 of 20 unattributed addresses resolved to a lead.
 *
 * `resolution` is stamped even when nothing is found, so an address EmailBison
 * has never seen is not retried on every tick forever — and "we looked and
 * found nothing" stays distinguishable from "not looked at yet".
 */
export const syncOutcomeAttribution: JobFn = async ({ teamId }): Promise<JobResult> => {
  const eb = createEmailBisonClient();
  const sb = getSupabase();
  let apiCalls = 0;

  const { data: pending } = await sb
    .from("outcome_events")
    .select("id, email, source_lead_id, resolved_client_id")
    .eq("team_id", teamId)
    .is("resolution", null)
    .not("email", "is", null)
    // Only `direct` rows. An Instantly outcome is already fully explained, and
    // an EmailBison one already carries its campaign.
    .eq("source_platform", "direct")
    .order("occurred_at", { ascending: false })
    .limit(400);

  if (!pending?.length) return { rowsWritten: 0, apiCalls: 0 };

  // One lookup per distinct address, not per event — the same person often has
  // several outcomes.
  const byEmail = new Map<string, typeof pending>();
  for (const row of pending) {
    const key = row.email!.trim().toLowerCase();
    byEmail.set(key, [...(byEmail.get(key) ?? []), row]);
  }

  /*
   * Which client each of our campaigns belongs to. The email match below finds
   * the campaign that emailed a person FIRST, and the same agents are prospected
   * by many brokerages at once — so that campaign frequently belongs to somebody
   * else. Measured against MasterInbox: the email path named the right client
   * 36 times and the wrong one 719 times.
   *
   * The feed now states the owner outright, so it arbitrates: a guessed campaign
   * is kept only when it belongs to the client the feed named, and discarded
   * otherwise. The outcome still counts for its client — resolved_client_id came
   * from the feed and is untouched by any of this — it simply stops being
   * credited to a campaign we cannot actually prove.
   */
  const { data: ownerRows } = await sb
    .from("campaign_clients")
    .select("campaign_id, client_id");
  const campaignOwner = new Map<number, string | null>(
    (ownerRows ?? []).map((r) => [r.campaign_id, r.client_id]),
  );

  const updates: Array<{ id: string; campaignId: number | null; how: string }> = [];
  let rejected = 0;

  await pool([...byEmail.keys()], 4, async (email) => {
    const events = byEmail.get(email)!;
    try {
      let leadId = events.find((e) => e.source_lead_id)?.source_lead_id ?? null;
      let how = leadId ? "lead_id" : "email";

      if (!leadId) {
        const found = await eb.searchLeads(email);
        apiCalls++;
        leadId = found[0]?.id ?? null;
      }

      if (!leadId) {
        for (const e of events) updates.push({ id: e.id, campaignId: null, how: "unresolved" });
        return;
      }

      const sends = await eb.getLeadSentEmails(leadId);
      apiCalls++;
      const first = (Array.isArray(sends?.data) ? sends.data : [])
        .filter((s) => s.sent_at && s.campaign_id)
        .sort(
          (a, b) =>
            new Date(String(a.sent_at)).getTime() - new Date(String(b.sent_at)).getTime(),
        )[0];

      const campaignId = first ? Number(first.campaign_id) : null;
      if (!campaignId) how = "unresolved";

      for (const e of events) {
        // The feed's client wins. A guessed campaign that belongs to a different
        // one is thrown away rather than published.
        const agrees =
          campaignId != null &&
          e.resolved_client_id != null &&
          campaignOwner.get(campaignId) === e.resolved_client_id;

        if (campaignId != null && !agrees) {
          rejected++;
          updates.push({ id: e.id, campaignId: null, how: "client_mismatch" });
        } else {
          updates.push({ id: e.id, campaignId, how });
        }
      }
    } catch {
      // Leave it unstamped so the next run retries — a transient API failure
      // must not be recorded as "this person does not exist".
    }
  });

  for (const u of updates) {
    await sb
      .from("outcome_events")
      .update({
        resolved_campaign_id: u.campaignId,
        resolution: u.how,
        resolved_at: new Date().toISOString(),
      })
      .eq("id", u.id);
  }

  return {
    rowsWritten: updates.length,
    apiCalls,
    detail: {
      attributed: updates.filter((u) => u.campaignId).length,
      unresolved: updates.filter((u) => !u.campaignId).length,
      // Guesses discarded because they named a campaign belonging to a different
      // client than the feed did. These used to be published as fact.
      rejected,
    },
  };
};

/**
 * Leads, for the Replies view's breakdowns (spec §5.5).
 *
 * SCOPED TO PEOPLE WHO HAVE ACTUALLY REPLIED, AND FETCHED ONE BY ONE.
 *
 * The view answers "what do our repliers have in common?", so only they matter:
 * 6,675 distinct leads out of 69,794. Two facts from EmailBison's pagination
 * docs decide the shape of this job:
 *
 *   * Page size is a FIXED 15 and `per_page` is ignored everywhere. A full walk
 *     of the lead list is 4,653 requests, and a cursor walk cannot be
 *     parallelised, so it is ~25 minutes of serial calls to find 10% of what it
 *     downloads.
 *   * Page-based paging is capped at 1000 pages, i.e. 15,000 records, and stops
 *     SILENTLY. The first version of this job hit exactly that guard and
 *     reported success having matched 464 of 6,677 repliers.
 *
 * Fetching by id instead runs at the client's concurrency of 4 and asks for
 * precisely the rows we need. Because it skips leads already stored, the first
 * run is a backfill and every run after it is seconds.
 */
export const syncLeads: JobFn = async ({ teamId }): Promise<JobResult> => {
  const eb = createEmailBisonClient();
  const sb = getSupabase();

  // Who has replied. Paged explicitly: PostgREST caps a select at 1000 rows and
  // truncates without saying so (CLAUDE.md rule 7).
  const repliers = new Set<number>();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await sb
      .from("replies")
      .select("lead_id")
      .eq("team_id", teamId)
      .not("lead_id", "is", null)
      .range(offset, offset + 999);
    if (error) throw new Error(`replies: ${error.message}`);
    for (const row of data ?? []) repliers.add(Number(row.lead_id));
    if (!data || data.length < 1000) break;
  }

  if (!repliers.size) return { rowsWritten: 0, apiCalls: 0, detail: { repliers: 0 } };

  // Skip what we already hold. This is what turns a 6,675-call backfill into a
  // handful of calls a night.
  const known = new Set<number>();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await sb
      .from("leads")
      .select("id")
      .eq("team_id", teamId)
      .range(offset, offset + 999);
    if (error) throw new Error(`leads: ${error.message}`);
    for (const row of data ?? []) known.add(Number(row.id));
    if (!data || data.length < 1000) break;
  }

  const missing = [...repliers].filter((id) => !known.has(id));

  /*
   * Bounded per run. A first backfill of 6,675 leads is ~9 minutes, which is
   * longer than a request should live, so the job takes a slice and the next
   * scheduled run continues — the same draining-queue shape as reply timing.
   */
  const batch = missing.slice(0, 2000);

  const leadRows: Record<string, unknown>[] = [];
  const attrRows: Record<string, unknown>[] = [];
  let apiCalls = 0;
  let missingUpstream = 0;
  let unparsedNumerics = 0;

  await pool(batch, 4, async (id) => {
    const lead = await eb.getLead(id);
    apiCalls++;
    if (!lead) {
      // Deleted upstream. Counted so a rise is visible rather than looking like
      // the queue simply never drains.
      missingUpstream++;
      return;
    }

    leadRows.push({
      id: lead.id,
      team_id: teamId,
      email: lead.email ?? null,
      first_name: lead.first_name ?? null,
      last_name: lead.last_name ?? null,
      // The replier's CURRENT employer. Never the client. See 027.
      company: lead.company ?? null,
      title: lead.title ?? null,
      status: lead.status ?? null,
      eb_created_at: lead.created_at ?? null,
      eb_updated_at: lead.updated_at ?? null,
      synced_at: new Date().toISOString(),
    });

    for (const variable of lead.custom_variables ?? []) {
      if (!variable?.name) continue;
      const value = variable.value ?? null;
      const numeric = parseNumericValue(value);
      // Most attributes are text ("Charlotte, NC") and are MEANT to be
      // unparseable, so only the ones a band is computed from are counted here.
      if (value && numeric === null && NUMERIC_LEAD_ATTRIBUTES.has(normaliseAttributeName(variable.name))) {
        unparsedNumerics++;
      }
      attrRows.push({
        lead_id: lead.id,
        team_id: teamId,
        name: normaliseAttributeName(variable.name),
        value,
        value_numeric: numeric,
      });
    }
  });

  // Attributes reference leads, so the parent rows must land first.
  await chunkUpsert("leads", leadRows, "id");
  await chunkUpsert("lead_attributes", attrRows, "lead_id,name");

  return {
    rowsWritten: leadRows.length + attrRows.length,
    apiCalls,
    detail: {
      repliers: repliers.size,
      alreadyHeld: known.size,
      fetched: leadRows.length,
      attributes: attrRows.length,
      stillMissing: missing.length - batch.length,
      missingUpstream,
      unparsedNumerics,
    },
  };
};

/** One conversation in MasterInbox, with whatever label is on it now. */
interface ReplyLabelRow {
  thread_id: string;
  source_provider: string;
  emailbison_reply_ids?: Array<number | string> | null;
  first_emailbison_reply_id?: number | string | null;
  label_name?: string | null;
  label_sentiment?: string | null;
  assigned_by?: string | null;
  labelled_at?: string | null;
  deleted?: boolean;
}

/**
 * Positive and Negative, from the labels the team actually applies.
 *
 * WHY THIS EXISTS. MasterInbox mirrors a label back into EmailBison's
 * `interested` flag, but only for the label named "Interested" — and
 * "Introduction", the larger positive group, never sets it. So Positive read 118
 * where the labels say 389. See 046 for the measurements.
 *
 * ONLY THE FIRST REPLY IN A THREAD IS CREDITED. A label belongs to a
 * conversation, and 338 threads hold more than one inbound reply (569 extra).
 * Labelling all of them would count one conversation as several positives.
 *
 * INSTANTLY IS SKIPPED. Same rule as the outcomes feed: another platform's
 * result is not ours to claim. Their rows carry no EmailBison reply id anyway,
 * so they cannot match — the filter is belt and braces, and it makes the
 * intent explicit rather than accidental.
 */
export function makeReplyLabelsJob(sweepDays: number | null): JobFn {
  return async ({ teamId, watermark }): Promise<JobResult> => {
    const base = (process.env.OUTCOMES_BASE_URL ?? "").replace(/\/$/, "");
    const token = process.env.OUTCOMES_TOKEN;
    if (!base || !token) {
      throw new Error("OUTCOMES_BASE_URL / OUTCOMES_TOKEN are not set");
    }

    const startedAt = new Date().toISOString();

    /*
     * THE DEEP SWEEP IS A WINDOW, NOT A FULL RE-READ, AND THAT IS FORCED.
     *
     * It used to send no `updated_since` at all, asking for every thread. That
     * request now fails: the endpoint returns 500 after ~8.5s, which is a
     * timeout rather than a rejection — measured 2026-08-28 across every page
     * size, so it is not about how much we ask for per page but how much the
     * query has to scan.
     *
     *   updated_since = 7 days   → 200 in  2.1s     993 threads
     *                  30 days   → 200 in  3.5s   3,000 threads
     *                  60 days   → 200 in  7.1s   6,421 threads
     *                  90 days   → 500 in  8.5s
     *                  none      → 500 in  8.5s
     *
     * So the wall sits somewhere past 60 days, and a from-scratch rebuild is
     * simply not available from this feed any more. 30 days is chosen for
     * margin, not for coverage: it is half the largest window that has ever
     * worked, on an endpoint whose timings vary by 2x between runs.
     *
     * That is enough for what this job is actually FOR. It is drift repair —
     * catching a label that changed while the frequent job's 6-hour overlap was
     * looking elsewhere — not a rebuild. A month of label changes is a wide net.
     *
     * What is genuinely lost: if a thread's label changed more than 30 days ago
     * AND the frequent job missed it at the time, nothing will now correct it.
     * Recovering that needs the endpoint fixed upstream, not a wider window here.
     */
    const since =
      sweepDays != null
        ? new Date(Date.now() - sweepDays * 86_400_000).toISOString()
        : watermark
          ? // A 6h overlap absorbs clock skew and any label applied while the
            // last run was mid-flight. Re-reading is free — the writer skips
            // unchanged rows.
            new Date(new Date(watermark).getTime() - 6 * 3600_000).toISOString()
          : null;

    const rows: ReplyLabelRow[] = [];
    let apiCalls = 0;

    for (let page = 1; ; page++) {
      const query = new URLSearchParams({ page: String(page), per_page: "200" });
      if (since) query.set("updated_since", since);

      const response = await fetch(`${base}/api/reply-labels?${query}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        cache: "no-store",
      });
      apiCalls++;
      if (!response.ok) {
        throw new Error(`Reply labels API ${response.status} on page ${page}`);
      }

      const body = await response.json();
      rows.push(...((body.data ?? []) as ReplyLabelRow[]));

      /*
       * Stop at last_page, never on an empty page. Asking for a page past the
       * end returns 500 on this feed — the same quirk /api/outcomes has — so a
       * loop-until-empty consumer would throw on every single run.
       */
      const lastPage = Number(body.meta?.last_page) || 1;
      if (page >= lastPage) break;
      if (page >= 200) {
        console.warn("[cron] sync-reply-labels: stopped at the 200-page guard");
        break;
      }
    }

    /*
     * A tombstone or a cleared label arrives as a row with no sentiment, and it
     * has to reach the writer as a NULL rather than being filtered out here.
     * Dropping them would mean Positive could only ever go up, and un-labelling
     * something would never show.
     */
    const payload = rows
      .filter((r) => r.source_provider === "emailbison")
      .map((r) => {
        const replyId = Number(r.first_emailbison_reply_id);
        if (!Number.isInteger(replyId) || replyId <= 0) return null;
        const cleared = Boolean(r.deleted) || !r.label_sentiment;
        return {
          reply_id: replyId,
          thread_id: cleared ? null : r.thread_id,
          sentiment: cleared ? null : r.label_sentiment,
          label: cleared ? null : (r.label_name ?? null),
          assigned_by: cleared ? null : (r.assigned_by ?? null),
          labelled_at: cleared ? null : (r.labelled_at ?? null),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    let labelled = 0;
    let cleared = 0;
    let unmatched = 0;

    // Chunked because the payload travels as one JSON body; 1,000 rows keeps it
    // well under any request-size limit while still being one statement each.
    for (let i = 0; i < payload.length; i += 1000) {
      const { data, error } = await getSupabase().rpc("apply_reply_labels", {
        p_team_id: teamId,
        p_rows: payload.slice(i, i + 1000),
      });
      if (error) throw new Error(`apply_reply_labels: ${error.message}`);
      const result = (data ?? [])[0] ?? {};
      labelled += Number(result.labelled ?? 0);
      cleared += Number(result.cleared ?? 0);
      unmatched += Number(result.unmatched ?? 0);
    }

    return {
      rowsWritten: labelled + cleared,
      apiCalls,
      watermark: startedAt,
      detail: {
        threads: rows.length,
        window: sweepDays != null ? `${sweepDays}d sweep` : "since watermark",
        emailbison: payload.length,
        instantly: rows.filter((r) => r.source_provider !== "emailbison").length,
        labelled,
        cleared,
        // Reply ids the feed offered that we do not hold — replies on excluded
        // or deleted campaigns. Rising means the two systems are drifting.
        unmatched,
      },
    };
  };
}


/**
 * Campaign lead membership, from the send feed.
 *
 * WHAT THIS BUYS. Before it, `leads` held only people who had replied — 6,700 of
 * ~69,800 — and nothing recorded which leads belonged to which campaign. There
 * is no EmailBison endpoint for that: the lead list is workspace-wide and
 * carries no campaign. Every SEND names both, and carries the whole lead object
 * with its custom variables, so one walk gives membership and lead detail with
 * no per-lead call.
 *
 * SHARDED PER CAMPAIGN, four at a time. A cursor is inherently serial, so one
 * global chain would take about an hour against a 6.7 req/s ceiling; four chains
 * saturate that ceiling and finish in about forty. Sharding is also the only
 * version with a resume point — one cursor per campaign, persisted after every
 * page, so a killed run loses one page rather than 1,239.
 *
 * RAW SENDS, NOT A RUNNING TOTAL. opens/clicks accrue for days after sent_at, so
 * a summed rollup cannot converge on a re-read. See 053.
 */
export function makeCampaignLeadsJob(windowDays: number | null, pageBudget: number): JobFn {
  return async ({ teamId }): Promise<JobResult> => {
    const eb = createEmailBisonClient();
    const sb = getSupabase();

    const campaigns = await scopedCampaigns(teamId);
    const { data: cursors } = await sb
      .from("campaign_send_sync")
      .select("campaign_id, backfill_cursor, backfilled_at")
      .eq("team_id", teamId);
    const stateBy = new Map((cursors ?? []).map((c) => [c.campaign_id, c]));

    const since = windowDays == null ? null : isoDaysAgo(windowDays);

    /*
     * WHICH CAMPAIGNS ARE WORTH ASKING ABOUT.
     *
     * A steady run used to open a cursor on all 105 campaigns, including the 85
     * that have not sent anything in the window — 85 requests to be told
     * nothing happened, every three hours, forever.
     *
     * campaign_day_stats already knows who sent and when, it is synced every
     * three hours anyway, and reading it costs one query. Measured: 20 of 105
     * campaigns sent in the last two days.
     *
     * A campaign still mid-backfill is never skipped — it has history to fetch
     * whether or not it sent this week.
     */
    let recentlyActive: Set<number> | null = null;
    if (since) {
      /*
       * THE GATE ONLY APPLIES IF THE THING IT READS IS ITSELF CURRENT.
       *
       * This skip depends on campaign_day_stats, which is written by another
       * job. If that job breaks, the table stops gaining recent rows, every
       * campaign looks quiet, and this one would skip all of them — quietly
       * doing nothing while reporting success, for as long as the other job
       * stayed broken. A silent no-op is the worst possible failure here
       * because nothing on any screen would look wrong.
       *
       * So: trust the gate only while sync-day-stats is fresh. If it is not,
       * ignore the gate and walk every campaign — slower, and correct.
       *
       * (A weekend legitimately produces zero activity — 8–9 Aug 2026 were a
       * Saturday and Sunday with 0 sends — which is exactly why "no active
       * campaigns" cannot be treated as evidence that anything is wrong.)
       */
      const { data: dayStats } = await sb
        .from("sync_state")
        .select("last_success_at")
        .eq("job_name", "sync-day-stats")
        .eq("team_id", teamId)
        .maybeSingle();

      const lastSuccess = dayStats?.last_success_at
        ? new Date(dayStats.last_success_at).getTime()
        : 0;
      // Its cadence is 3h; 12h is four missed runs, the same multiple the
      // health thresholds use.
      const dayStatsFresh = Date.now() - lastSuccess < 12 * 3600_000;

      if (dayStatsFresh) {
        const { data: active } = await sb
          .from("campaign_day_stats")
          .select("campaign_id")
          .eq("team_id", teamId)
          .gte("stat_date", since)
          .gt("emails_sent", 0);
        recentlyActive = new Set((active ?? []).map((r) => r.campaign_id));
      } else {
        console.warn(
          "[sync] campaign-leads: sync-day-stats is stale, so the quiet-campaign skip is disabled",
        );
      }
    }

    let pagesRead = 0;
    let skippedQuiet = 0;
    let apiCalls = 0;
    let backfillRemaining = 0;
    let sendsWritten = 0;
    let leadsWritten = 0;
    let attrsWritten = 0;
    const touched = new Set<number>();

    /*
     * FLUSHED PER CAMPAIGN, and the ordering matters.
     *
     * The first version accumulated every row and wrote once at the end, which
     * is wrong twice over: it holds 258,000 rows in memory during a backfill,
     * and it stamps a campaign "backfilled" as its cursor runs out while its
     * rows are still unsaved. A crash between those two points would leave the
     * campaign marked done with nothing stored, and nothing would ever re-fetch
     * it — the exact failure the watermark discipline exists to prevent.
     *
     * So: write the rows, THEN mark the campaign finished. A crash re-walks a
     * campaign, which is free because every write is an idempotent upsert.
     */
    const flush = async (
      campaignId: number,
      sends: Record<string, unknown>[],
      leadRows: Map<number, Record<string, unknown>>,
      attrRows: Map<string, Record<string, unknown>>,
    ) => {
      if (!sends.length) return;
      // Leads before attributes (foreign key), both before the sends.
      /*
       * Chunk sizes matter more here than anywhere else in the sync. Each lead
       * carries twelve custom variables, so a 600-row flush wrote ~7,200
       * attribute rows — fifteen sequential round trips to Supabase, in the
       * middle of the walk, while no API request was in flight. Measured at
       * roughly half the wall clock. Bigger chunks turn eighteen round trips
       * into four.
       */
      await chunkUpsert("leads", [...leadRows.values()], "id", 2000);
      await chunkUpsert("lead_attributes", [...attrRows.values()], "lead_id,name", 4000);
      await chunkUpsert("campaign_lead_sends", sends, "id", 2000);
      sendsWritten += sends.length;
      leadsWritten += leadRows.size;
      attrsWritten += attrRows.size;
      touched.add(campaignId);
    };

    /*
     * TWELVE, not four, and this is what actually governs the speed.
     *
     * A cursor is serial within a campaign, so the number of campaigns walked at
     * once IS the number of requests in flight. The gate allows 12; a pool of 4
     * meant it could never see more than 4, and raising the gate alone changed
     * nothing — measured before and after, both ~4.8 req/s.
     */
    await pool(campaigns, 12, async (campaign) => {
      const state = stateBy.get(campaign.id);
      const backfilling = !state?.backfilled_at;
      if (!backfilling && pagesRead >= pageBudget) return;

      // Nothing sent in the window and nothing left to backfill — do not ask.
      if (!backfilling && recentlyActive && !recentlyActive.has(campaign.id)) {
        skippedQuiet++;
        return;
      }

      let cursor = backfilling ? (state?.backfill_cursor ?? null) : null;
      // A backfill reads everything; a steady run only the trailing window.
      const window = backfilling ? null : since;

      const sends: Record<string, unknown>[] = [];
      const leadRows = new Map<number, Record<string, unknown>>();
      const attrRows = new Map<string, Record<string, unknown>>();

      for (;;) {
        if (pagesRead >= pageBudget) {
          if (backfilling) backfillRemaining++;
          // Save the partial walk and leave the cursor where it is, so the next
          // run resumes rather than repeating it.
          await flush(campaign.id, sends, leadRows, attrRows);
          await sb.from("campaign_send_sync").upsert(
            {
              campaign_id: campaign.id,
              team_id: teamId,
              backfill_cursor: cursor,
              backfilled_at: null,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "campaign_id" },
          );
          return;
        }

        const page = await eb.getSentEmailsPage(campaign.id, cursor, window);
        apiCalls++;
        pagesRead++;

        for (const row of page.data ?? []) {
          const leadId = row.lead?.id;
          if (!leadId) continue;
          touched.add(campaign.id);

          sends.push({
            id: row.id,
            team_id: teamId,
            campaign_id: campaign.id,
            lead_id: leadId,
            sequence_step_id: row.sequence_step_id ?? null,
            sender_email_id: row.sender_email?.id ?? null,
            sent_at: row.sent_at ?? null,
            thread_reply: row.thread_reply ?? null,
            opens: Number(row.opens ?? 0),
            unique_opens: Number(row.unique_opens ?? 0),
            clicks: Number(row.clicks ?? 0),
            synced_at: new Date().toISOString(),
          });

          /*
           * The lead, from the same row. This is what lifts `leads` from
           * repliers-only to everyone contacted — and it improves the Replies
           * view's breakdowns for free, since they read the same table.
           */
          leadRows.set(leadId, {
            id: leadId,
            team_id: teamId,
            email: row.lead?.email ?? null,
            first_name: row.lead?.first_name ?? null,
            last_name: row.lead?.last_name ?? null,
            company: row.lead?.company ?? null,
            title: row.lead?.title ?? null,
            status: row.lead?.status ?? null,
            eb_created_at: row.lead?.created_at ?? null,
            eb_updated_at: row.lead?.updated_at ?? null,
            synced_at: new Date().toISOString(),
          });

          for (const v of row.lead?.custom_variables ?? []) {
            if (!v?.name) continue;
            const name = normaliseAttributeName(v.name);
            if (!name) continue;
            attrRows.set(`${leadId}\u0000${name}`, {
              lead_id: leadId,
              team_id: teamId,
              name,
              value: v.value ?? null,
              value_numeric: NUMERIC_LEAD_ATTRIBUTES.has(name)
                ? parseNumericValue(v.value)
                : null,
            });
          }
        }

        const next = page.meta?.next_cursor ?? null;
        if (!next || next === cursor) {
          // End of this campaign: rows first, THEN the finished stamp.
          await flush(campaign.id, sends, leadRows, attrRows);
          await sb.from("campaign_send_sync").upsert(
            {
              campaign_id: campaign.id,
              team_id: teamId,
              backfill_cursor: null,
              backfilled_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            { onConflict: "campaign_id" },
          );
          break;
        }
        cursor = next;

        /*
         * Flush every 100 pages (1,500 rows) mid-walk so a 1,239-page campaign
         * neither holds everything in memory nor loses it all to one failure.
         * The cursor moves with it, so a resume picks up where the rows stop.
         */
        // 1,500 rather than 600: fewer, larger flushes amortise the write cost
        // over more pages without holding an unbounded buffer.
        if (sends.length >= 1500) {
          await flush(campaign.id, sends, leadRows, attrRows);
          sends.length = 0;
          leadRows.clear();
          attrRows.clear();
          if (backfilling) {
            await sb.from("campaign_send_sync").upsert(
              {
                campaign_id: campaign.id,
                team_id: teamId,
                backfill_cursor: cursor,
                backfilled_at: null,
                updated_at: new Date().toISOString(),
              },
              { onConflict: "campaign_id" },
            );
          }
        }
      }
    });

    if (touched.size) {
      const { error } = await sb.rpc("refresh_campaign_leads", {
        p_team_id: teamId,
        p_campaign_ids: [...touched],
      });
      if (error) throw new Error(`refresh_campaign_leads: ${error.message}`);
    }

    return {
      rowsWritten: sendsWritten,
      apiCalls,
      detail: {
        pagesRead,
        sends: sendsWritten,
        leads: leadsWritten,
        attributes: attrsWritten,
        campaignsTouched: touched.size,
        // Campaigns that sent nothing in the window, so were never asked.
        skippedQuiet,
        // Campaigns still mid-backfill when the page budget ran out. Reported so
        // "is it finished yet" is answerable without reading the cursor table.
        backfillRemaining,
        mode: windowDays == null ? "backfill" : `${windowDays}d window`,
      },
    };
  };
}


/*
 * Which mail provider each replier's domain actually uses, from its MX record.
 *
 * WHY DNS AND NOT THE DOMAIN NAME. Reading the address gets you gmail.com and
 * then stops — 41.6% of replies come from company domains (1,041 distinct) that
 * say nothing on their face. Their MX record says it exactly:
 *
 *   realestatewithfox.com -> aspmx.l.google.com     -> Google Workspace
 *   rodeore.com           -> ...mail.protection.outlook.com -> Microsoft 365
 *
 * This is the lookup that "Email Provider" on the Leads screen was omitted for.
 * There it would have been a guess from the domain, right about a third of the
 * time; here it is measured.
 *
 * CACHED PER DOMAIN, FOREVER-ISH. An organisation changes mail provider once
 * every few years, so a resolved domain is never re-queried and a failed one is
 * recorded as 'Unknown' rather than retried on every run — 1,041 failing lookups
 * a night would be a self-inflicted outage, and the answer would not change.
 */
const ESP_BY_MX: Array<[RegExp, string]> = [
  [/(^|\.)google(mail)?\.com$|(^|\.)googlemail\.l\./i, "Google Workspace"],
  [/protection\.outlook\.com$|(^|\.)outlook\.com$|(^|\.)hotmail\.com$/i, "Microsoft 365"],
  [/(^|\.)zoho(cloud)?\.(com|eu)$/i, "Zoho"],
  [/(^|\.)yahoodns\.net$|(^|\.)yahoo\.com$/i, "Yahoo"],
  [/(^|\.)icloud\.com$|(^|\.)apple\.com$/i, "Apple iCloud"],
  [/(^|\.)secureserver\.net$/i, "GoDaddy"],
  [/(^|\.)registrar-servers\.com$|(^|\.)privateemail\.com$/i, "Namecheap"],
  [/(^|\.)pphosted\.com$|(^|\.)proofpoint\./i, "Proofpoint"],
  [/(^|\.)mimecast\./i, "Mimecast"],
  [/(^|\.)barracudanetworks\.com$/i, "Barracuda"],
  [/(^|\.)messagingengine\.com$/i, "Fastmail"],
  [/(^|\.)ionos\.|(^|\.)1and1\./i, "IONOS"],
  [/(^|\.)titan\.email$|(^|\.)flockmail\.com$/i, "Titan"],
  [/(^|\.)mail\.ru$|(^|\.)yandex\./i, "Yandex"],
];

function espFromMx(host: string | null): string {
  if (!host) return "No mail server";
  for (const [pattern, name] of ESP_BY_MX) if (pattern.test(host)) return name;
  /*
   * Not "Unknown". The MX host IS the answer, we just have no friendly name for
   * it — showing the hostname's own domain keeps a real provider visible instead
   * of dropping a genuine long tail into one meaningless bucket.
   */
  const parts = host.replace(/\.$/, "").split(".");
  return parts.length >= 2 ? parts.slice(-2).join(".") : host;
}

export const syncEspDomains: JobFn = async ({ teamId }): Promise<JobResult> => {
  const sb = getSupabase();
  const dns = await import("node:dns");

  /*
   * The work queue: replier domains we have never looked up. Read from the
   * replies themselves rather than from leads, because this dimension describes
   * the person who REPLIED, and a lead who never replied cannot appear on the
   * card anyway.
   */
  const { data: rows, error } = await sb.rpc("unresolved_reply_domains", {
    p_team_id: teamId,
    p_limit: 2000,
  });
  if (error) throw new Error(`unresolved_reply_domains: ${error.message}`);

  const domains = ((rows ?? []) as Array<{ domain: string }>).map((r) => r.domain);
  if (!domains.length) return { rowsWritten: 0, apiCalls: 0, detail: { resolved: 0, pending: 0 } };

  const resolved: Record<string, unknown>[] = [];
  let failures = 0;

  // DNS is cheap and parallel-friendly; 20 at a time keeps the resolver happy.
  await pool(domains, 20, async (domain) => {
    try {
      const records = await dns.promises.resolveMx(domain);
      // Lowest preference wins — that is the primary exchanger.
      const best = records.sort((a, b) => a.priority - b.priority)[0];
      const host = best?.exchange ?? null;
      resolved.push({
        domain,
        esp: espFromMx(host),
        mx_host: host,
        checked_at: new Date().toISOString(),
      });
    } catch {
      /*
       * NXDOMAIN, no MX, or a timeout. Recorded rather than skipped, so the
       * queue drains — an unrecorded failure would be retried on every run for
       * ever, and the answer would not change.
       */
      failures++;
      resolved.push({
        domain,
        esp: "Unknown",
        mx_host: null,
        checked_at: new Date().toISOString(),
      });
    }
  });

  await chunkUpsert("esp_domains", resolved, "domain", 1000);

  return {
    rowsWritten: resolved.length,
    apiCalls: 0, // DNS, not EmailBison — this spends no API budget
    detail: {
      resolved: resolved.length - failures,
      unresolvable: failures,
      distinctEsps: new Set(resolved.map((r) => r.esp)).size,
    },
  };
};

export const JOBS = {
  "sync-entities": syncEntities,
  "sync-steps": syncSteps,
  "sync-reply-timing": syncReplyTiming,
  "sync-senders": syncSenders,
  "sync-leads": syncLeads,
  "sync-outcomes": syncOutcomes,
  "sync-outcome-attribution": syncOutcomeAttribution,
  // Frequent: usually one page per campaign.
  "sync-replies": makeRepliesJob(48),
  // Nightly: the full 600-call walk, which also repairs `interested` flips that
  // happened outside the incremental window.
  "sync-replies-deep": makeRepliesJob(null),
  // Recent days only: late events mutate them, older days are settled.
  "sync-daily-series": makeDailySeriesJob(7),
  // Nightly drift repair against EmailBison's own corrections.
  "sync-daily-series-deep": makeDailySeriesJob(120),
  "sync-day-stats": makeDayStatsJob(3),
  "sync-day-stats-deep": makeDayStatsJob(14),
  // Labels move as fast as the team works the inbox, and an incremental run is
  // one or two pages. The nightly full walk catches anything the cursor missed.
  "sync-reply-labels": makeReplyLabelsJob(null),
  // 30 days, not "everything" — the feed can no longer serve an unbounded read.
  // See the note in makeReplyLabelsJob.
  "sync-reply-labels-deep": makeReplyLabelsJob(30),
  /*
   * The page budget is set by STALE_LOCK_MS in runner.ts: at ~6.7 req/s, 3,000
   * pages is about 7.5 minutes, comfortably inside the 10-minute lock so a
   * concurrent tick never steals it and runs a second copy.
   */
  // DNS only — no EmailBison budget spent, and the queue drains to empty.
  "sync-esp-domains": syncEspDomains,
  "sync-campaign-leads": makeCampaignLeadsJob(2, 3000),
  // The wide window exists to re-read opens and clicks that accrued after the
  // send — the thing a summed rollup could never have picked up.
  "sync-campaign-leads-deep": makeCampaignLeadsJob(7, 3000),
} satisfies Record<string, JobFn>;

export const JOB_NAMES = Object.keys(JOBS);

/** Narrows an untrusted string (a URL segment, a schedule entry) to a real job. */
export function getJob(name: string): JobFn | undefined {
  return Object.hasOwn(JOBS, name)
    ? JOBS[name as keyof typeof JOBS]
    : undefined;
}
