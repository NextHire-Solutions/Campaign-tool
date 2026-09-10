import { createInstantlyClient } from "@/lib/instantly/client.ts";
import { getSupabase } from "@/lib/supabase/server";
import { chunkUpsert } from "./jobs.ts";
import { exclusionReason, matchCampaign } from "@/lib/clients/match.ts";
import { setCursor, setCursorText } from "./runner";
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

    /*
     * ONE CALL PER DAY, not one per campaign.
     *
     * /campaigns/analytics returns EVERY campaign's figures for whatever range
     * it is given, so asking for a single day yields the whole workspace for
     * that day. Three things follow, and all of them are why this replaced a
     * per-campaign fan-out over the daily-series endpoint:
     *
     *  - IT CARRIES BOUNCES. The daily-series endpoint has no bounce field at
     *    all, which forced the KPI band to dash bounces whenever Instantly was
     *    in scope. Verified: nine daily calls sum to exactly the same bounce
     *    total as one nine-day ranged call.
     *  - IT IS CHEAPER. 45 days is 45 requests against 113 for one per active
     *    campaign, and it no longer scales with the number of campaigns.
     *  - IT AGREES WITH THE WORKSPACE SERIES. A single day's sends matched the
     *    daily endpoint exactly (942 = 942).
     */
    const rows: Record<string, unknown>[] = [];
    let calls = 0;

    for (let back = windowDays; back >= 0; back--) {
      const day = daysAgo(back);
      const perCampaign = await client.getCampaignAnalytics({ from: day, to: day });
      calls++;

      for (const c of perCampaign) {
        /*
         * A day with nothing on it is not a fact worth storing, and storing it
         * would make "no data" and "a real zero" identical (rule 1). The ranged
         * endpoint returns a row for every campaign whether or not it acted.
         */
        if (!c.emails_sent_count && !c.reply_count && !c.bounced_count) continue;
        rows.push({
          campaign_id: c.campaign_id,
          team_id: teamId,
          stat_date: day,
          sent: c.emails_sent_count ?? 0,
          contacted: c.contacted_count ?? 0,
          new_leads_contacted: c.new_leads_contacted_count ?? 0,
          opened: c.open_count ?? 0,
          unique_opened: c.open_count_unique ?? 0,
          replies: c.reply_count ?? 0,
          unique_replies: c.reply_count_unique ?? c.reply_count ?? 0,
          replies_automatic: c.reply_count_automatic ?? 0,
          clicks: c.link_click_count ?? 0,
          opportunities: c.total_opportunities ?? 0,
          bounced: c.bounced_count ?? 0,
          unsubscribed: c.unsubscribed_count ?? 0,
          leads_count: c.leads_count ?? null,
          completed: c.completed_count ?? null,
          fetched_at: new Date().toISOString(),
        });
      }
    }

    if (rows.length) {
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await sb
          .from("instantly_campaign_day_stats")
          .upsert(rows.slice(i, i + 500), { onConflict: "campaign_id,stat_date" });
        if (error) throw new Error(`instantly day stats: ${error.message}`);
      }
    }

    return {
      rowsWritten: rows.length,
      apiCalls: calls,
      detail: {
        window: `${daysAgo(windowDays)} → ${daysAgo(0)}`,
        days: calls,
        rows: rows.length,
        bounces: rows.reduce((n, r) => n + Number(r.bounced ?? 0), 0),
      },
    };
  };
}

export const syncInstantlyDayStats = makeInstantlyDayStatsJob(3);
/** Nightly drift repair over a wide window. */
export const syncInstantlyDayStatsDeep = makeInstantlyDayStatsJob(45);

/*
 * THE HISTORY BEFORE THE WINDOW.
 *
 * The two jobs above walk BACK FROM TODAY — 3 days for drift, 45 nightly — so
 * they keep recent figures honest and can never reach anything older. That left
 * the daily series holding 96,055 sends against a lifetime of 789,679: a 90-day
 * view returned 45 days of data and said nothing about it, which is a wrong
 * number wearing a confident label.
 *
 * A DRAINING QUEUE, the same shape as sync-instantly-replies-backfill: it walks
 * one chunk older per run and becomes a no-op once it reaches the floor. That
 * is what keeps it inside the ten-minute job lock instead of trying to fetch
 * eleven months in a single run.
 *
 * THE CURSOR IS `sync_state.cursor_date` — the oldest day already fetched — and
 * NOT "the oldest row we hold", which is what the replies backfill uses. A day
 * on which nothing happened stores no row by design (rule 1: an absent day and
 * a zero day must not look alike), so a row-derived cursor would stall on the
 * first quiet day and re-fetch it forever.
 */
const BACKFILL_DAYS_PER_RUN = 120;

/** Nothing precedes Instantly's first reply; without a floor this walks forever. */
const BACKFILL_FLOOR = "2025-06-01";

export const syncInstantlyDayStatsBackfill: JobFn = async ({
  cursorDate,
}): Promise<JobResult> => {
  const client = createInstantlyClient();
  const teamId = TEAM_ID();
  const sb = getSupabase();

  /*
   * Where to resume. On the very first run there is no cursor, so it starts at
   * the oldest day the window jobs have already stored and works back from
   * there — no overlap, no gap.
   */
  let from = cursorDate;
  if (!from) {
    const { data } = await sb
      .from("instantly_campaign_day_stats")
      .select("stat_date")
      .eq("team_id", teamId)
      .order("stat_date", { ascending: true })
      .limit(1);
    from = ((data ?? [])[0]?.stat_date as string | undefined) ?? daysAgo(45);
  }

  const floor = BACKFILL_FLOOR;
  if (from <= floor) {
    return { rowsWritten: 0, apiCalls: 0, detail: { status: "complete", oldest: from } };
  }

  const rows: Record<string, unknown>[] = [];
  let calls = 0;
  let day = from;
  let reached = from;

  for (let i = 0; i < BACKFILL_DAYS_PER_RUN; i++) {
    const previous = new Date(`${day}T00:00:00Z`);
    previous.setUTCDate(previous.getUTCDate() - 1);
    day = previous.toISOString().slice(0, 10);
    if (day < floor) break;

    const perCampaign = await client.getCampaignAnalytics({ from: day, to: day });
    calls++;
    reached = day;

    for (const c of perCampaign) {
      // Same rule as the window jobs: a day with nothing on it is not a fact.
      if (!c.emails_sent_count && !c.reply_count && !c.bounced_count) continue;
      rows.push({
        campaign_id: c.campaign_id,
        team_id: teamId,
        stat_date: day,
        sent: c.emails_sent_count ?? 0,
        contacted: c.contacted_count ?? 0,
        new_leads_contacted: c.new_leads_contacted_count ?? 0,
        opened: c.open_count ?? 0,
        unique_opened: c.open_count_unique ?? 0,
        replies: c.reply_count ?? 0,
        unique_replies: c.reply_count_unique ?? c.reply_count ?? 0,
        replies_automatic: c.reply_count_automatic ?? 0,
        clicks: c.link_click_count ?? 0,
        opportunities: c.total_opportunities ?? 0,
        bounced: c.bounced_count ?? 0,
        unsubscribed: c.unsubscribed_count ?? 0,
        leads_count: c.leads_count ?? null,
        completed: c.completed_count ?? null,
        fetched_at: new Date().toISOString(),
      });
    }
  }

  if (rows.length) {
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await sb
        .from("instantly_campaign_day_stats")
        .upsert(rows.slice(i, i + 500), { onConflict: "campaign_id,stat_date" });
      if (error) throw new Error(`instantly day stats backfill: ${error.message}`);
    }
  }

  /*
   * The cursor moves ONLY after the writes land. Advancing it first would skip
   * a chunk permanently on a failed upsert, and the whole point of a draining
   * queue is that a failed run costs a retry rather than a hole.
   */
  await setCursor("sync-instantly-day-stats-backfill", teamId, reached);

  return {
    rowsWritten: rows.length,
    apiCalls: calls,
    detail: {
      from,
      reached,
      days: calls,
      rows: rows.length,
      remaining: reached <= floor ? 0 : Math.round((Date.parse(reached) - Date.parse(floor)) / 86_400_000),
    },
  };
};

/*
 * Account tags — the pools, so "assign Nicole Pool to these campaigns" means
 * the same thing on both platforms.
 *
 * Cheap and complete in one run: two endpoints, about eleven calls, no
 * watermark. Tags change rarely and a full rewrite is simpler to reason about
 * than a delta — an account that LOSES a tag has to lose it here too, and a
 * delta sync is exactly where that gets missed.
 */
export const syncInstantlyAccountTags: JobFn = async (): Promise<JobResult> => {
  const client = createInstantlyClient();
  const teamId = TEAM_ID();
  const sb = getSupabase();

  const byEmail = await client.getAccountTags();

  const { data: accounts } = await sb
    .from("instantly_accounts")
    .select("email")
    .eq("team_id", teamId);

  const rows = ((accounts ?? []) as Array<{ email: string }>).map((a) => ({
    email: a.email,
    team_id: teamId,
    // EVERY account is written, including the untagged ones — that is what
    // clears a tag someone removed upstream. Writing only the tagged ones would
    // make removal invisible.
    tags: byEmail.get(a.email.toLowerCase()) ?? [],
  }));

  await chunkUpsert("instantly_accounts", rows, "email");

  const tagged = rows.filter((r) => r.tags.length).length;
  return {
    rowsWritten: rows.length,
    apiCalls: 11,
    detail: {
      accounts: rows.length,
      tagged,
      untagged: rows.length - tagged,
      pools: [...new Set([...byEmail.values()].flat())].sort(),
    },
  };
};

/*
 * Every lead in the workspace, with the campaign it belongs to.
 *
 * RESUMABLE, because a full walk is ~405 calls and about 4.4 minutes against a
 * 10-minute job lock. Each run does a bounded number of pages and stores the
 * cursor; the next run picks it up. When the walk ends the cursor is cleared,
 * so the following run starts again from the top and the table converges on
 * the current truth rather than drifting.
 *
 * A FULL RE-WALK RATHER THAN A DELTA, deliberately. There is no "leads changed
 * since" filter, and a lead that MOVES campaign has to move here too — a delta
 * keyed on new leads would leave it in both places, which is precisely the kind
 * of membership error that makes a Leads tab untrustworthy.
 */
const LEAD_PAGES_PER_RUN = 120;

export const syncInstantlyLeads: JobFn = async ({ cursorText }): Promise<JobResult> => {
  const client = createInstantlyClient();
  const teamId = TEAM_ID();

  const rows: Record<string, unknown>[] = [];
  let after = cursorText ?? undefined;
  let calls = 0;
  let finished = false;

  for (let page = 0; page < LEAD_PAGES_PER_RUN; page++) {
    const { items, next } = await client.listLeadsPage({ limit: 100, startingAfter: after });
    calls++;

    for (const l of items) {
      rows.push({
        id: l.id,
        team_id: teamId,
        campaign_id: (l.campaign as string) ?? null,
        email: (l.email as string) ?? null,
        first_name: (l.first_name as string) ?? null,
        last_name: (l.last_name as string) ?? null,
        company_name: (l.company_name as string) ?? null,
        company_domain: (l.company_domain as string) ?? null,
        status: l.status ?? null,
        esp_code: l.esp_code ?? null,
        email_reply_count: Number(l.email_reply_count ?? 0),
        email_open_count: Number(l.email_open_count ?? 0),
        email_click_count: Number(l.email_click_count ?? 0),
        last_contact_at: (l.timestamp_last_contact as string) ?? null,
        eb_created_at: (l.timestamp_created as string) ?? null,
        synced_at: new Date().toISOString(),
      });
    }

    after = next;
    if (!next || !items.length) {
      finished = true;
      break;
    }
  }

  if (rows.length) await chunkUpsert("instantly_leads", rows, "id");

  /*
   * The cursor moves only AFTER the rows land, and is cleared at the end of the
   * walk so the next run restarts. Advancing it first would skip a page
   * permanently on a failed upsert.
   */
  await setCursorText("sync-instantly-leads", teamId, finished ? null : (after ?? null));

  return {
    rowsWritten: rows.length,
    apiCalls: calls,
    detail: {
      pages: calls,
      leads: rows.length,
      resumedFrom: cursorText ? "cursor" : "start",
      status: finished ? "walk complete" : "more pages next run",
    },
  };
};

// --- per-inbox sending figures ------------------------------------------------

/**
 * @param windowDays how far back to read. CAPPED AT 31 by Instantly itself.
 *
 * Infrastructure ranks inboxes by bounce rate, and Instantly's account list
 * carries no counters at all — only status, daily limit and warmup state. These
 * rows are the only place its per-inbox sends and bounces exist.
 *
 * A window rather than a watermark, for the same reason the campaign day-stats
 * job uses one: figures for recent days keep moving as late bounces land, and
 * upserting on (email, stat_date) is what makes re-reading them converge.
 */
function makeInstantlyAccountStatsJob(windowDays: number): JobFn {
  return async (): Promise<JobResult> => {
    const client = createInstantlyClient();
    const teamId = TEAM_ID();
    const sb = getSupabase();

    /*
     * 30, not 31. The API's cap is 31 days and its range is INCLUSIVE at both
     * ends, so `daysAgo(31)` → today is 32 days and returns a 400. Off by one,
     * and the error said only "Bad Request" until the client was taught to
     * surface the API's own sentence.
     */
    const days = Math.min(windowDays, 30);
    const from = daysAgo(days);
    const to = daysAgo(0);

    const { data: accounts } = await sb
      .from("instantly_accounts")
      .select("email")
      .eq("team_id", teamId)
      .is("archived_at", null);
    const emails = ((accounts ?? []) as Array<{ email: string }>).map((a) => a.email);
    if (!emails.length) {
      return { rowsWritten: 0, apiCalls: 0, detail: { status: "no accounts synced yet" } };
    }

    const stats = await client.getAccountDailyStats(emails, from, to);

    const rows = stats
      // A day with nothing on it is not a fact worth storing, and storing it
      // would make "no data" and "a real zero" identical (rule 1).
      .filter((r) => (r.sent ?? 0) > 0 || (r.bounced ?? 0) > 0 || (r.replies ?? 0) > 0)
      .map((r) => ({
        email: r.email_account,
        team_id: teamId,
        stat_date: r.date,
        sent: r.sent ?? 0,
        bounced: r.bounced ?? 0,
        contacted: r.contacted ?? 0,
        replies: r.replies ?? 0,
        unique_replies: r.unique_replies ?? r.replies ?? 0,
        opened: r.opened ?? 0,
        clicks: r.clicks ?? 0,
        fetched_at: new Date().toISOString(),
      }));

    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await sb
        .from("instantly_account_day_stats")
        .upsert(rows.slice(i, i + 500), { onConflict: "email,stat_date" });
      if (error) throw new Error(`instantly account stats: ${error.message}`);
    }

    return {
      rowsWritten: rows.length,
      apiCalls: Math.ceil(emails.length / 180),
      detail: {
        window: `${from} → ${to}`,
        accounts: emails.length,
        rows: rows.length,
        sent: rows.reduce((n, r) => n + r.sent, 0),
        bounced: rows.reduce((n, r) => n + r.bounced, 0),
      },
    };
  };
}

export const syncInstantlyAccountStats = makeInstantlyAccountStatsJob(7);
/** The widest window the API allows, nightly, to catch late bounces. */
export const syncInstantlyAccountStatsDeep = makeInstantlyAccountStatsJob(31);

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
