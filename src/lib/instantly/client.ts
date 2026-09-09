import type {
  InstantlyAccount,
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

  private async request<T>(path: string, attempt = 0): Promise<T> {
    // The one endpoint with its own budget.
    if (path.startsWith("/emails")) {
      const wait = this.nextEmailsAt - Date.now();
      if (wait > 0) await sleep(wait);
      this.nextEmailsAt = Date.now() + EMAILS_MIN_GAP_MS;
    }

    const response = await fetch(`${this.baseUrl}/api/v2${path}`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
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
      return this.request<T>(path, attempt + 1);
    }

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text().catch(() => null);
      }
      throw new InstantlyApiError(
        `Instantly ${response.status} ${response.statusText} on ${path}`,
        response.status,
        body,
      );
    }

    return (await response.json()) as T;
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
}

export function createInstantlyClient(): InstantlyClient {
  const apiKey = process.env.INSTANTLY_API_KEY;
  if (!apiKey) throw new Error("INSTANTLY_API_KEY is not set");
  return new InstantlyClient({
    baseUrl: process.env.INSTANTLY_BASE_URL || "https://api.instantly.ai",
    apiKey,
  });
}
