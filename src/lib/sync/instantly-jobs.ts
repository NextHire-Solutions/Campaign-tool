import { createInstantlyClient } from "@/lib/instantly/client.ts";
import { getSupabase } from "@/lib/supabase/server";
import { chunkUpsert } from "./jobs.ts";
import { exclusionReason, matchCampaign } from "@/lib/clients/match.ts";
import type { JobFn, JobResult } from "./runner";

/*
 * Pulling Instantly into the dashboard.
 *
 * Same three rules as every EmailBison job: idempotent, watermark advances only
 * on success, and a missed tick is a non-event because re-running converges.
 *
 * The shapes differ enough to be worth naming:
 *
 *  - Instantly hands back EVERY campaign's metrics in ONE call, where
 *    EmailBison needs one call per campaign. So the campaign sync is cheap.
 *  - The daily series carries no campaign id, so per-campaign days need one
 *    call each — 317 calls, well inside the 6,000/min budget.
 *  - `/emails` allows only 20 requests a minute. A full reply walk is ~227
 *    pages, so eleven minutes. That single limit is why replies sync
 *    incrementally off a watermark and why the deep sweep is a separate job.
 */

const TEAM_ID = () => Number(process.env.EMAILBISON_TEAM_ID || 2);

function domainOf(email: string | null | undefined): string | null {
  if (!email || !email.includes("@")) return null;
  return email.split("@").pop()!.toLowerCase();
}

/** ISO date (UTC) N days back from now. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

// --- campaigns + their lifetime metrics --------------------------------------

export const syncInstantlyCampaigns: JobFn = async (): Promise<JobResult> => {
  const client = createInstantlyClient();
  const teamId = TEAM_ID();
  const sb = getSupabase();

  const [campaigns, analytics] = await Promise.all([
    client.getAllCampaigns(),
    // Every campaign's lifetime metrics in a single call.
    client.getCampaignAnalytics(),
  ]);

  const statsById = new Map(analytics.map((a) => [a.campaign_id, a]));

  const rows = campaigns.map((c) => {
    const a = statsById.get(c.id);
    return {
      id: c.id,
      team_id: teamId,
      name: c.name,
      status: c.status ?? null,
      is_evergreen: a?.campaign_is_evergreen ?? null,
      leads_count: a?.leads_count ?? null,
      contacted_count: a?.contacted_count ?? null,
      emails_sent: a?.emails_sent_count ?? null,
      reply_count: a?.reply_count ?? null,
      reply_count_unique: a?.reply_count_unique ?? null,
      reply_count_automatic: a?.reply_count_automatic ?? null,
      bounced_count: a?.bounced_count ?? null,
      unsubscribed_count: a?.unsubscribed_count ?? null,
      completed_count: a?.completed_count ?? null,
      opportunities: a?.total_opportunities ?? null,
      opportunity_value: a?.total_opportunity_value ?? null,
      eb_created_at: c.timestamp_created ?? null,
      synced_at: new Date().toISOString(),
      // Reappearing un-archives, so a restored campaign returns on its own.
      archived_at: null,
    };
  });

  await chunkUpsert("instantly_campaigns", rows, "id");

  /*
   * RECONCILE DELETIONS, with the guard sync-senders earned the hard way (060):
   * a walk returning far less than we hold is a truncated walk, not a mass
   * deletion, and acting on it would archive a working estate on one bad
   * response.
   */
  const seen = new Set(rows.map((r) => r.id));
  const { data: live } = await sb
    .from("instantly_campaigns")
    .select("id")
    .eq("team_id", teamId)
    .is("archived_at", null);
  const stale = ((live ?? []) as Array<{ id: string }>)
    .map((r) => r.id)
    .filter((id) => !seen.has(id));

  const suspicious = rows.length < (live?.length ?? 0) * 0.5;
  let archived = 0;
  if (stale.length && !suspicious) {
    const { error } = await sb
      .from("instantly_campaigns")
      .update({ archived_at: new Date().toISOString() })
      .eq("team_id", teamId)
      .in("id", stale);
    if (error) throw new Error(`instantly campaign archive: ${error.message}`);
    archived = stale.length;
  } else if (suspicious) {
    console.warn(
      `[sync-instantly-campaigns] declined to archive ${stale.length}: walk returned ` +
        `${rows.length} against ${live?.length ?? 0} live — looks truncated`,
    );
  }

  return {
    rowsWritten: rows.length,
    // 4 pages of campaigns + 1 analytics call.
    apiCalls: Math.ceil(rows.length / 100) + 1,
    detail: {
      campaigns: rows.length,
      withMetrics: rows.filter((r) => (r.emails_sent ?? 0) > 0).length,
      archived,
    },
  };
};

// --- which client each campaign belongs to ------------------------------------

/**
 * Resolves Instantly campaigns to clients.
 *
 * THE SAME MATCHER EMAILBISON USES, deliberately. Instantly follows the same
 * naming convention — "Camelot Realty Group - Houston", "Howe Realty Group (2)
 * - Maricopa" — so the rules that already work apply unchanged. A second
 * implementation would be a second definition of which campaigns are a
 * client's, and the two would drift.
 *
 * `manual` pins are never recomputed (rule 9): a human decision is not
 * something a sync gets to overwrite.
 */
export const syncInstantlyClients: JobFn = async (): Promise<JobResult> => {
  const sb = getSupabase();
  const teamId = TEAM_ID();

  const [{ data: clientDetail }, { data: campaigns }, { data: pinned }] =
    await Promise.all([
      sb.from("clients").select("id, name, aliases, match_mode").eq("team_id", teamId),
      sb
        .from("instantly_campaigns")
        .select("id, name")
        .eq("team_id", teamId)
        .is("archived_at", null),
      sb
        .from("instantly_campaign_clients")
        .select("campaign_id")
        .eq("match_method", "manual"),
    ]);

  const matchable = (clientDetail ?? []).map((c) => ({
    id: c.id as string,
    name: c.name as string,
    aliases: (c.aliases ?? []) as string[],
    matchMode: c.match_mode as "contains" | "prefix" | "exact",
  }));
  const pinnedIds = new Set(
    ((pinned ?? []) as Array<{ campaign_id: string }>).map((p) => p.campaign_id),
  );

  const rows = ((campaigns ?? []) as Array<{ id: string; name: string }>)
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

  await chunkUpsert("instantly_campaign_clients", rows, "campaign_id");

  return {
    rowsWritten: rows.length,
    apiCalls: 0,
    detail: {
      campaigns: rows.length,
      matched: rows.filter((r) => r.client_id).length,
      unmatched: rows.filter((r) => !r.client_id && !r.excluded).length,
      excluded: rows.filter((r) => r.excluded).length,
      ambiguous: rows.filter((r) => r.ambiguous).length,
      pinned: pinnedIds.size,
    },
  };
};

// --- sending accounts ---------------------------------------------------------

export const syncInstantlyAccounts: JobFn = async (): Promise<JobResult> => {
  const client = createInstantlyClient();
  const teamId = TEAM_ID();
  const sb = getSupabase();

  const accounts = await client.getAllAccounts();
  const rows = accounts.map((a) => ({
    email: a.email,
    team_id: teamId,
    first_name: a.first_name ?? null,
    last_name: a.last_name ?? null,
    // Derived here so the by-domain rollup is consistent for every row, the
    // same reasoning as sender_emails.
    domain: domainOf(a.email),
    status: a.status ?? null,
    warmup_status: a.warmup_status ?? null,
    provider_code: a.provider_code ?? null,
    daily_limit: a.daily_limit ?? null,
    eb_created_at: a.timestamp_created ?? null,
    synced_at: new Date().toISOString(),
    archived_at: null,
  }));

  await chunkUpsert("instantly_accounts", rows, "email");

  const seen = new Set(rows.map((r) => r.email));
  const { data: live } = await sb
    .from("instantly_accounts")
    .select("email")
    .eq("team_id", teamId)
    .is("archived_at", null);
  const stale = ((live ?? []) as Array<{ email: string }>)
    .map((r) => r.email)
    .filter((e) => !seen.has(e));

  let archived = 0;
  if (stale.length && rows.length >= (live?.length ?? 0) * 0.5) {
    await sb
      .from("instantly_accounts")
      .update({ archived_at: new Date().toISOString() })
      .eq("team_id", teamId)
      .in("email", stale);
    archived = stale.length;
  }

  /*
   * Status counts are reported RAW rather than reduced to "active", and that is
   * deliberate. Instantly documents the field as 1 Active · 2 Paused ·
   * 3 Maintenance · -1/-2/-3 error states, and every one of the 536 accounts
   * reports 2 — yet the workspace sent 786 emails on 2026-09-08 and 6,139 on
   * 08-31. Filtering the API by status=1 returns nothing, so the field is
   * self-consistent; it simply does not mean what "Paused" implies here.
   *
   * Reporting "0 active" would be a confident claim contradicted by the send
   * volume sitting next to it. Until that is understood, this counts what the
   * API actually said and names nothing.
   */
  const byStatus: Record<string, number> = {};
  for (const r of rows) {
    const key = r.status === null ? "unknown" : String(r.status);
    byStatus[key] = (byStatus[key] ?? 0) + 1;
  }

  return {
    rowsWritten: rows.length,
    apiCalls: Math.ceil(rows.length / 100),
    detail: {
      accounts: rows.length,
      byStatus,
      domains: new Set(rows.map((r) => r.domain).filter(Boolean)).size,
      archived,
    },
  };
};

// --- the daily series, per campaign ------------------------------------------

/**
 * @param windowDays how far back to re-fetch.
 *
 * A window rather than a watermark, deliberately: Instantly revises recent days
 * after the fact exactly as EmailBison does — late bounces, replies that arrive
 * hours after the send — so the only way last week's numbers stay right is to
 * re-read them. Upserting on (campaign_id, stat_date) makes that converge.
 */
function makeInstantlyDayStatsJob(windowDays: number): JobFn {
  return async (): Promise<JobResult> => {
    const client = createInstantlyClient();
    const teamId = TEAM_ID();
    const sb = getSupabase();

    const from = daysAgo(windowDays);
    const to = daysAgo(0);

    /*
     * Ask which campaigns were ACTIVE in the window first. Instantly answers
     * that in one call, and it turns 317 per-campaign requests into however
     * many actually sent — 18 for a recent nine-day range. The rest have
     * nothing to report and asking would be 299 calls for empty arrays.
     */
    const active = await client.getCampaignAnalytics({ from, to });

    const rows: Record<string, unknown>[] = [];
    let calls = 1;

    for (const campaign of active) {
      const days = await client.getDailyAnalytics(from, to, campaign.campaign_id);
      calls++;
      for (const d of days) {
        // A day with nothing on it is not a fact worth storing, and storing it
        // would make "no data" and "a real zero" identical (rule 1).
        if (!d.sent && !d.replies && !d.contacted) continue;
        rows.push({
          campaign_id: campaign.campaign_id,
          team_id: teamId,
          stat_date: d.date,
          sent: d.sent ?? 0,
          contacted: d.contacted ?? 0,
          new_leads_contacted: d.new_leads_contacted ?? 0,
          opened: d.opened ?? 0,
          unique_opened: d.unique_opened ?? 0,
          replies: d.replies ?? 0,
          unique_replies: d.unique_replies ?? 0,
          replies_automatic: d.replies_automatic ?? 0,
          clicks: d.clicks ?? 0,
          opportunities: d.opportunities ?? 0,
          fetched_at: new Date().toISOString(),
        });
      }
    }

    if (rows.length) {
      const { error } = await sb
        .from("instantly_campaign_day_stats")
        .upsert(rows, { onConflict: "campaign_id,stat_date" });
      if (error) throw new Error(`instantly day stats: ${error.message}`);
    }

    return {
      rowsWritten: rows.length,
      apiCalls: calls,
      detail: {
        window: `${from} → ${to}`,
        activeCampaigns: active.length,
        days: rows.length,
      },
    };
  };
}

export const syncInstantlyDayStats = makeInstantlyDayStatsJob(3);
/** Nightly drift repair over a wide window. */
export const syncInstantlyDayStatsDeep = makeInstantlyDayStatsJob(45);

// --- replies ------------------------------------------------------------------

/**
 * @param full walk everything, rather than from the watermark.
 *
 * THE 20/MIN CAP SHAPES THIS ENTIRELY. A complete walk of 22,685 replies is
 * ~227 pages and about eleven minutes of wall clock. So the frequent job reads
 * only what is new — `min_timestamp_created`, minus an overlap — and the full
 * re-walk is a separate nightly job that is allowed to take its time.
 */
/**
 * Pages a run may spend.
 *
 * runner.ts treats a lock older than TEN MINUTES as stale and lets another tick
 * take it. At the documented 20 requests/minute a page costs 3.2s, so 150 pages
 * is about eight minutes — inside the lock with room to spare. A full walk of
 * all 22,685 replies is ~227 pages, about twelve minutes, which would OVERRUN
 * the lock and invite a second copy of the same walk to start and fight this
 * one for the same 20/min budget. Both would then fail on 429s.
 *
 * So no run is unbounded. The window is what varies.
 */
const MAX_PAGES_PER_RUN = 150;

function makeInstantlyRepliesJob(windowDays: number | null): JobFn {
  return async (): Promise<JobResult> => {
    const client = createInstantlyClient();
    const teamId = TEAM_ID();
    const sb = getSupabase();

    let since: string | undefined;

    if (windowDays !== null) {
      // A fixed window: the drift-repair sweep, bounded so it fits the lock.
      since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
    } else {
      /*
       * Read from `created_at`, the SAME field /emails filters on. Reading the
       * watermark from received_at and comparing it against timestamp_created
       * is comparing two clocks, and anything written to Instantly later than
       * its own send time would fall in the gap and never be fetched.
       */
      const { data } = await sb
        .from("instantly_replies")
        .select("created_at")
        .eq("team_id", teamId)
        .not("created_at", "is", null)
        .order("created_at", { ascending: false })
        .limit(1);
      const newest = (data ?? [])[0]?.created_at as string | undefined;
      /*
       * A 48-hour overlap, matching sync-replies. Re-reading two days costs a
       * few pages and closes the window where a late write would be skipped.
       */
      if (newest) {
        since = new Date(new Date(newest).getTime() - 48 * 3_600_000).toISOString();
      }
    }

    const emails = await client.getEmails({ since, maxPages: MAX_PAGES_PER_RUN });
    // Hitting the cap means real data was left behind, so the run says so
    // rather than reporting a clean finish over a truncated walk.
    const trimmed = emails.length >= MAX_PAGES_PER_RUN * 100;

    const rows = emails.map((e) => {
      const at = e.timestamp_email || e.timestamp_created;
      return {
        id: e.id,
        team_id: teamId,
        campaign_id: e.campaign_id ?? null,
        lead_email: e.lead ?? null,
        from_email: e.from_address_email ?? null,
        eaccount: e.eaccount ?? null,
        subject: e.subject ?? null,
        preview: e.content_preview ?? null,
        thread_id: e.thread_id ?? null,
        step: e.step ?? null,
        ue_type: e.ue_type ?? null,
        i_status: e.i_status ?? null,
        ai_interest_value: e.ai_interest_value ?? null,
        received_at: at ?? null,
        received_date: at ? at.slice(0, 10) : null,
        created_at: e.timestamp_created ?? null,
        synced_at: new Date().toISOString(),
      };
    });

    await chunkUpsert("instantly_replies", rows, "id");

    return {
      rowsWritten: rows.length,
      apiCalls: Math.ceil(rows.length / 100) + 1,
      detail: {
        mode:
          windowDays !== null
            ? `sweep (${windowDays}d)`
            : `incremental (from ${since ?? "the beginning"})`,
        replies: rows.length,
        withCampaign: rows.filter((r) => r.campaign_id).length,
        ...(trimmed ? { truncated: `hit the ${MAX_PAGES_PER_RUN}-page cap` } : {}),
      },
    };
  };
}

/**
 * Fills in reply history, oldest-ward, a bounded slice per run.
 *
 * A WATERMARK CANNOT DO THIS. /emails is newest-first, so the incremental job
 * only ever moves forward — the first run captured the newest 15,000 of 22,685
 * and no amount of re-running it would reach the 7,685 behind them. This walks
 * the other way, from the oldest row we hold, using max_timestamp_created.
 *
 * A DRAINING QUEUE, like sync-esp-domains: it does real work while history is
 * missing and becomes a no-op the moment it is complete. That shape is what
 * lets it respect both the 20-requests-per-minute cap and the ten-minute job
 * lock — it never tries to finish in one run, it just gets closer.
 */
export const syncInstantlyRepliesBackfill: JobFn = async (): Promise<JobResult> => {
  const client = createInstantlyClient();
  const teamId = TEAM_ID();
  const sb = getSupabase();

  const { data } = await sb
    .from("instantly_replies")
    .select("created_at")
    .eq("team_id", teamId)
    .not("created_at", "is", null)
    .order("created_at", { ascending: true })
    .limit(1);
  const oldest = (data ?? [])[0]?.created_at as string | undefined;

  if (!oldest) {
    // Nothing held yet: the incremental job seeds from the newest end first,
    // and starting both from an empty table would just fetch the same pages.
    return { rowsWritten: 0, apiCalls: 0, detail: { status: "waiting for the first sync" } };
  }

  const emails = await client.getEmails({
    // Exclusive-ish: the oldest row we hold comes back again and upserts to
    // itself, which is cheaper than tracking an offset and cannot skip a row.
    until: oldest,
    maxPages: MAX_PAGES_PER_RUN,
  });

  const rows = emails.map((e) => {
    const at = e.timestamp_email || e.timestamp_created;
    return {
      id: e.id,
      team_id: teamId,
      campaign_id: e.campaign_id ?? null,
      lead_email: e.lead ?? null,
      from_email: e.from_address_email ?? null,
      eaccount: e.eaccount ?? null,
      subject: e.subject ?? null,
      preview: e.content_preview ?? null,
      thread_id: e.thread_id ?? null,
      step: e.step ?? null,
      ue_type: e.ue_type ?? null,
      i_status: e.i_status ?? null,
      ai_interest_value: e.ai_interest_value ?? null,
      received_at: at ?? null,
      received_date: at ? at.slice(0, 10) : null,
      created_at: e.timestamp_created ?? null,
      synced_at: new Date().toISOString(),
    };
  });

  await chunkUpsert("instantly_replies", rows, "id");

  /*
   * Only the row we already had came back, so there is nothing older left.
   * Reporting that explicitly matters: "0 new" and "finished" look identical
   * from the outside, and one of them means the backfill is still needed.
   */
  const complete = rows.length <= 1;

  return {
    rowsWritten: rows.length,
    apiCalls: Math.ceil(rows.length / 100) + 1,
    detail: {
      walkedBackFrom: oldest,
      fetched: rows.length,
      status: complete ? "history complete" : "more history remaining",
    },
  };
};

export const syncInstantlyReplies = makeInstantlyRepliesJob(null);
/*
 * 45 days rather than everything. The all-time walk does not fit the lock, and
 * a sweep exists to repair recent drift, not to re-import history — history is
 * seeded once by the backfill script and then never changes.
 */
export const syncInstantlyRepliesDeep = makeInstantlyRepliesJob(45);
