import type {
  InstantlyAccount,
  InstantlyAccountDailyRow,
  InstantlyCampaign,
  InstantlyCampaignAnalytics,
  InstantlyDailyRow,
  InstantlyEmail,
  InstantlyPage,
} from "./types.ts";

/*
 * Instantly v2 HTTP client.
 *
 * Deliberately NOT a copy of the EmailBison client. The two APIs fail in
 * different ways and the differences are the whole point of a separate file:
 *
 *  - Pagination is `starting_after` + `next_starting_after`, and `limit` is
 *    capped at 100 — 200 returns 400 rather than clamping, so a hopeful
 *    `limit=500` breaks the walk instead of speeding it up.
 *  - The rate limits are generous (6,000/min) EXCEPT on `/emails`, which allows
 *    20/min. That one endpoint dictates how the reply sync is written.
 *  - Instantly returns bare arrays from the analytics endpoints and `{items}`
 *    from the list endpoints. Neither is wrapped in `{data}` the way EmailBison
 *    wraps everything.
 */

const MAX_PAGE = 100;

/**
 * Minimum gap between `/emails` requests.
 *
 * The documented cap is 20 per minute — 3,000ms apart. 3,200 leaves a margin so
 * a clock difference or a retry cannot tip us over: a 429 here costs far more
 * than the 200ms, because the reply walk is 227 pages and restarting it is
 * eleven minutes.
 */
const EMAILS_MIN_GAP_MS = 3_200;

export class InstantlyApiError extends Error {
  readonly statusCode: number;
  readonly response?: unknown;

  constructor(message: string, statusCode: number, response?: unknown) {
    super(message);
    this.name = "InstantlyApiError";
    this.statusCode = statusCode;
    this.response = response;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class InstantlyClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  /** When the next `/emails` call may start. Module-level pacing, one gate. */
  private nextEmailsAt = 0;

  constructor({ baseUrl, apiKey }: { baseUrl: string; apiKey: string }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  private async request<T>(
    path: string,
    init?: { method: "POST" | "PATCH" | "DELETE"; body?: unknown },
    attempt = 0,
  ): Promise<T> {
    // The one endpoint with its own budget.
    if (path.startsWith("/emails")) {
      const wait = this.nextEmailsAt - Date.now();
      if (wait > 0) await sleep(wait);
      this.nextEmailsAt = Date.now() + EMAILS_MIN_GAP_MS;
    }

    const response = await fetch(`${this.baseUrl}/api/v2${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      // Instantly is external and its numbers move constantly; caching here
      // would serve stale analytics that look current.
      cache: "no-store",
    });

    if (response.status === 429 && attempt < 4) {
      /*
       * Back off hard rather than politely. A 429 means the workspace budget is
       * spent, and the budget is shared with every other key and with v1 — so a
       * short retry is likely to be refused again and burn another slot.
       */
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 5_000 * 2 ** attempt);
      return this.request<T>(path, init, attempt + 1);
    }

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text().catch(() => null);
      }
      /*
       * The PATH IS TRUNCATED and the API's own message put first.
       *
       * /accounts/analytics/daily carries up to 180 emails in its querystring,
       * so the full path is thousands of characters — an error containing it
       * buries the one sentence that says what went wrong ("Analytics date
       * range cannot exceed 31 days") under a wall of URL-encoded addresses.
       */
      const reason =
        body && typeof body === "object" && "message" in body
          ? String((body as { message?: unknown }).message)
          : undefined;
      const shortPath = path.length > 120 ? `${path.slice(0, 120)}…` : path;
      throw new InstantlyApiError(
        reason
          ? `Instantly ${response.status}: ${reason} (${shortPath})`
          : `Instantly ${response.status} ${response.statusText} on ${shortPath}`,
        response.status,
        body,
      );
    }

    /*
     * A write can answer 204, or 200 with an empty body. `response.json()`
     * throws on both, which would turn a successful delete into a failure.
     */
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  /**
   * Walks a `{items, next_starting_after}` endpoint to exhaustion.
   *
   * `limit` is pinned to 100 because that is the documented maximum and asking
   * for more returns 400 — an error, not a smaller page, so a larger value
   * fails the whole walk rather than merely slowing it.
   */
  private async walk<T extends { id?: string; email?: string }>(
    path: string,
    params: Record<string, string> = {},
    maxPages = 500,
  ): Promise<T[]> {
    const all: T[] = [];
    let cursor: string | null = null;
    let pages = 0;

    for (;;) {
      const query = new URLSearchParams({ ...params, limit: String(MAX_PAGE) });
      if (cursor) query.set("starting_after", cursor);

      const page: InstantlyPage<T> = await this.request<InstantlyPage<T>>(
        `${path}?${query.toString()}`,
      );
      all.push(...(page.items ?? []));
      pages++;

      const next = page.next_starting_after ?? null;
      if (!next) break;
      if (next === cursor) {
        console.warn(`[instantly] ${path}: cursor stopped advancing at page ${pages}`);
        break;
      }
      if (pages >= maxPages) {
        console.warn(
          `[instantly] ${path}: hit the ${maxPages}-page guard — DATA WAS LEFT BEHIND`,
        );
        break;
      }
      cursor = next;
    }

    return all;
  }

  // --- campaigns --------------------------------------------------------------

  async getAllCampaigns(): Promise<InstantlyCampaign[]> {
    return this.walk<InstantlyCampaign>("/campaigns");
  }

  /**
   * Per-campaign metrics — every campaign in ONE call.
   *
   * With a date range it returns ONLY campaigns active in that window (18 of
   * 317 for a nine-day range), which is the right shape for a windowed table
   * but means an absent campaign is dormant, not missing.
   */
  async getCampaignAnalytics(
    range?: { from: string; to: string },
  ): Promise<InstantlyCampaignAnalytics[]> {
    // A single day is just a range whose ends are equal; callers asking for one
    // day get every campaign's figures FOR that day, bounces included.
    const query = new URLSearchParams();
    if (range) {
      query.set("start_date", range.from);
      query.set("end_date", range.to);
    }
    const suffix = query.toString() ? `?${query}` : "";
    const body = await this.request<InstantlyCampaignAnalytics[]>(
      `/campaigns/analytics${suffix}`,
    );
    return Array.isArray(body) ? body : [];
  }

  /**
   * The daily series. WITHOUT `campaignId` this is workspace-wide — the rows
   * carry no campaign id either way, so a per-campaign series needs one call
   * per campaign.
   */
  async getDailyAnalytics(
    from: string,
    to: string,
    campaignId?: string,
  ): Promise<InstantlyDailyRow[]> {
    const query = new URLSearchParams({ start_date: from, end_date: to });
    if (campaignId) query.set("campaign_id", campaignId);
    const body = await this.request<InstantlyDailyRow[]>(
      `/campaigns/analytics/daily?${query}`,
    );
    return Array.isArray(body) ? body : [];
  }

  // --- accounts ---------------------------------------------------------------

  async getAllAccounts(): Promise<InstantlyAccount[]> {
    return this.walk<InstantlyAccount>("/accounts");
  }

  /**
   * Per-account, per-day sending figures.
   *
   * TWO HARD LIMITS, both found by hitting them and both enforced here rather
   * than left to the caller:
   *
   *   * the range may not exceed 31 DAYS — 400 beyond that;
   *   * at most 200 EMAILS per request — 400 at 300, and a 536-email
   *     querystring is refused outright with 431 Request Header Fields Too
   *     Large, which is a transport failure rather than an API one and would
   *     not look like a rate problem at all.
   *
   * Batched at 180 to stay clear of the second, which makes the whole estate 3
   * requests per window.
   */
  async getAccountDailyStats(
    emails: string[],
    from: string,
    to: string,
  ): Promise<InstantlyAccountDailyRow[]> {
    const BATCH = 180;
    const out: InstantlyAccountDailyRow[] = [];

    for (let i = 0; i < emails.length; i += BATCH) {
      const query = new URLSearchParams({ start_date: from, end_date: to });
      for (const email of emails.slice(i, i + BATCH)) query.append("emails", email);
      const body = await this.request<InstantlyAccountDailyRow[]>(
        `/accounts/analytics/daily?${query.toString()}`,
      );
      if (Array.isArray(body)) out.push(...body);
    }

    return out;
  }

  // --- emails -----------------------------------------------------------------

  /**
   * Replies, newest first, optionally only those created after `since`.
   *
   * PACED AT 20/MIN by the gate in `request`. A full walk is ~227 pages and
   * therefore ~11 minutes, which is why callers pass `since` and why the reply
   * job is incremental — see docs/instantly-api-findings.md.
   */
  async getEmails(options: {
    since?: string;
    /**
     * Upper bound, for walking BACKWARDS into history.
     *
     * The list is newest-first, so a watermark can only ever move forward: it
     * fetches what arrived since the last run and can never reach anything
     * older than the first page it ever saw. Filling in history needs the other
     * end of the range, which is what this is.
     */
    until?: string;
    maxPages?: number;
  } = {}): Promise<InstantlyEmail[]> {
    /*
     * `email_type=received` IS LOAD-BEARING, not an optimisation.
     *
     * /emails is the whole unibox — every message, in both directions. Walking
     * it unfiltered returned 14,839 outbound campaign sends for every 137 real
     * replies, so a table called `replies` filled up with sent mail and the
     * walk could never finish: the workspace has 840,416 sends against 22,685
     * replies, and at 20 requests a minute that is days rather than minutes.
     *
     * The `ue_type` query parameter looks like it would do the same job and is
     * silently IGNORED — `?ue_type=2` returns the same mixed page. Only
     * `email_type=received` filters, and it returns 100% ue_type 2. Verified
     * both ways.
     */
    const params: Record<string, string> = { email_type: "received" };
    if (options.since) params.min_timestamp_created = options.since;
    if (options.until) params.max_timestamp_created = options.until;
    return this.walk<InstantlyEmail>("/emails", params, options.maxPages ?? 500);
  }

  // --- writes ------------------------------------------------------------
  /*
   * Every method below matches a contract verified against a disposable
   * campaign on 2026-09-10 (docs/instantly-api-findings.md). Nothing here can
   * start a campaign: `activate` is deliberately absent, because the only
   * caller that would ever want it is one that has already decided to email
   * thousands of real people, and that decision does not belong in a client.
   */

  /**
   * A campaign, created paused.
   *
   * `campaign_schedule` is required, and its timezone is a CLOSED ENUM of 102
   * values that does not include `America/New_York` — a wrong value is a 400,
   * not a fallback. `America/Detroit` is the Eastern entry.
   */
  async createCampaign(input: {
    name: string;
    timezone?: string;
    from?: string;
    to?: string;
  }): Promise<{ id: string }> {
    return this.request<{ id: string }>("/campaigns", {
      method: "POST",
      body: {
        name: input.name,
        campaign_schedule: {
          schedules: [
            {
              name: "Default",
              timing: { from: input.from ?? "09:00", to: input.to ?? "17:00" },
              days: { 1: true, 2: true, 3: true, 4: true, 5: true },
              timezone: input.timezone ?? "America/Detroit",
            },
          ],
        },
      },
    });
  }

  async getCampaign(id: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`/campaigns/${id}`);
  }

  async updateCampaign(id: string, patch: Record<string, unknown>): Promise<unknown> {
    return this.request(`/campaigns/${id}`, { method: "PATCH", body: patch });
  }

  /** Carries the SEQUENCE and no leads — the same shape as EmailBison's. */
  async duplicateCampaign(id: string): Promise<{ id: string }> {
    return this.request<{ id: string }>(`/campaigns/${id}/duplicate`, {
      method: "POST",
      body: {},
    });
  }

  /**
   * Starts a campaign sending. THE DANGEROUS ONE.
   *
   * Deliberately not added until there was a caller that guards it: the bulk
   * action route refuses `resume` without `confirm: true`, and the only client
   * that sets that flag is a dialog naming every campaign and its lead count.
   *
   * Verified on a campaign with 0 leads and 0 inboxes — which cannot send to
   * anyone — where it moved status 0 → 1, and pause moved it back to 2. That is
   * the only responsible way to learn this contract: guessing about an endpoint
   * that starts emailing thousands of people is not an option, and neither is
   * shipping it unverified.
   */
  async activateCampaign(id: string): Promise<unknown> {
    return this.request(`/campaigns/${id}/activate`, { method: "POST", body: {} });
  }

  async pauseCampaign(id: string): Promise<unknown> {
    return this.request(`/campaigns/${id}/pause`, { method: "POST", body: {} });
  }

  async deleteCampaign(id: string): Promise<unknown> {
    return this.request(`/campaigns/${id}`, { method: "DELETE" });
  }

  /**
   * The sending inboxes, as a WHOLE-ARRAY REPLACE.
   *
   * Instantly has no attach/remove pair — `email_list` on the campaign is the
   * assignment. So adding one inbox means reading the current list, appending,
   * and writing it back; callers that skip the read silently detach everything
   * already assigned. That asymmetry with EmailBison is why this is named for
   * what it does rather than for the feature it serves.
   */
  async setCampaignInboxes(id: string, emails: string[]): Promise<unknown> {
    return this.request(`/campaigns/${id}`, {
      method: "PATCH",
      body: { email_list: emails },
    });
  }

  async getCampaignInboxes(id: string): Promise<string[]> {
    const campaign = await this.getCampaign(id);
    const list = campaign?.email_list;
    return Array.isArray(list) ? (list as string[]) : [];
  }

  /** Leads currently in a campaign. */
  async listCampaignLeads(
    campaignId: string,
    limit = 100,
  ): Promise<Array<Record<string, unknown>>> {
    const page = await this.request<{ items?: Array<Record<string, unknown>> }>(
      "/leads/list",
      { method: "POST", body: { campaign: campaignId, limit } },
    );
    return page?.items ?? [];
  }

  /** Removes leads from a campaign. Ids only — never a bare campaign_id. */
  async removeLeads(campaignId: string, ids: string[]): Promise<unknown> {
    return this.request("/leads", {
      method: "DELETE",
      body: { campaign_id: campaignId, ids },
    });
  }

  /**
   * Moves a campaign's leads to another campaign.
   *
   * A MOVE, not a copy: the source is emptied. Instantly offers no copy, and
   * `/leads` (which would add rather than move) is refused while the workspace
   * is over its lead limit. Callers must be explicit with the user about that
   * — it is the opposite of EmailBison's re-campaign, which leaves the source
   * intact.
   *
   * `ids` alone is rejected with "A source campaign or list is required".
   */
  async moveCampaignLeads(fromCampaignId: string, toCampaignId: string): Promise<unknown> {
    return this.request("/leads/move", {
      method: "POST",
      body: { campaign: fromCampaignId, to_campaign_id: toCampaignId },
    });
  }

  /**
   * Account tags, resolved through Instantly's separate custom-tags resource.
   *
   * Accounts do NOT carry their tags inline — `GET /accounts` returns none — so
   * this is a two-call join: the tag list for names, then the mappings for
   * which resource carries which tag. `resource_type: 1` is an account, and the
   * `resource_id` is the address itself rather than an id.
   *
   * Returns a map of email → tag names, so the caller writes one row per
   * account instead of reasoning about the join.
   */
  async getAccountTags(): Promise<Map<string, string[]>> {
    const tagPage = await this.request<{ items?: Array<{ id: string; label?: string; name?: string }> }>(
      "/custom-tags?limit=100",
    );
    const nameById = new Map(
      (tagPage?.items ?? []).map((t) => [t.id, (t.label ?? t.name ?? "").trim()]),
    );

    const byEmail = new Map<string, string[]>();
    let after: string | undefined;
    // Bounded: the workspace has ~1,000 mappings, and an unbounded walk over a
    // paginated endpoint is how a sync job becomes an infinite loop.
    for (let page = 0; page < 60; page++) {
      const url = `/custom-tag-mappings?limit=100${after ? `&starting_after=${after}` : ""}`;
      const res = await this.request<{
        items?: Array<{ tag_id: string; resource_id: string; resource_type: number }>;
        next_starting_after?: string;
      }>(url);
      const items = res?.items ?? [];
      for (const m of items) {
        if (m.resource_type !== 1) continue; // not an account
        const name = nameById.get(m.tag_id);
        if (!name) continue;
        const email = String(m.resource_id).toLowerCase();
        const existing = byEmail.get(email);
        if (existing) existing.push(name);
        else byEmail.set(email, [name]);
      }
      after = res?.next_starting_after;
      if (!after || !items.length) break;
    }
    return byEmail;
  }

  /**
   * One page of the workspace's leads, in cursor order.
   *
   * No campaign filter: the response carries each lead's `campaign`, so a
   * single walk yields membership for every campaign at once. Filtering per
   * campaign would be 318 walks for the same rows.
   *
   * Paged rather than exhaustive on purpose — a full walk is ~405 calls and
   * about 4.4 minutes measured, against a 10-minute job lock, so the CALLER
   * decides how much to do in one run and where to resume.
   */
  async listLeadsPage(options: { limit?: number; startingAfter?: string } = {}): Promise<{
    items: Array<Record<string, unknown>>;
    next?: string;
  }> {
    const res = await this.request<{
      items?: Array<Record<string, unknown>>;
      next_starting_after?: string;
    }>("/leads/list", {
      method: "POST",
      body: {
        limit: options.limit ?? 100,
        ...(options.startingAfter ? { starting_after: options.startingAfter } : {}),
      },
    });
    return { items: res?.items ?? [], next: res?.next_starting_after };
  }

  /** Plan limits, so a caller can explain a refusal instead of retrying it. */
  async getLeadQuota(): Promise<{ limit: number; used: number; remaining: number }> {
    const plan = await this.request<{
      subscriptions?: { outreach?: { total_lead_limit?: number; current_lead_count?: number } };
    }>("/workspace-billing/plan-details");
    const limit = Number(plan?.subscriptions?.outreach?.total_lead_limit ?? 0);
    const used = Number(plan?.subscriptions?.outreach?.current_lead_count ?? 0);
    return { limit, used, remaining: Math.max(limit - used, 0) };
  }
}

export function createInstantlyClient(): InstantlyClient {
  const apiKey = process.env.INSTANTLY_API_KEY;
  if (!apiKey) throw new Error("INSTANTLY_API_KEY is not set");
  return new InstantlyClient({
    baseUrl: process.env.INSTANTLY_BASE_URL || "https://api.instantly.ai",
    apiKey,
  });
}
