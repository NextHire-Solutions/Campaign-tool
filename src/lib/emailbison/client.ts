import { limited, reportRateLimit } from "./rate-limit.ts";
import { assertApplied, EmailBisonApiError } from "./errors.ts";

// Re-exported so existing importers keep working.
export { EmailBisonApiError } from "./errors.ts";
import type {
  EBCampaign,
  EBCampaignStats,
  EBConversationThread,
  EBDailySeriesResponse,
  EBLead,
  EBReply,
  EBSenderEmail,
  EBSentEmail,
  EBSequenceStepsResponse,
  EBWorkspace,
  Paginated,
} from "./types.ts";

/*
 * EmailBison HTTP client.
 *
 * Ported from outreachify-revyops with three changes:
 *   - one instance, so the BASE_URLS map is gone (base URL is env-configurable
 *     so a second instance stays a config change, not a code change);
 *   - every request goes through the rate-limit gate;
 *   - only the methods v1 actually needs.
 *
 * Two details are carried over VERBATIM because they were clearly earned in
 * production: the error path that tries .json() then falls back to .text()
 * before throwing, and the `{data: ...}` unwrap guard on single-resource GETs
 * (EmailBison is inconsistent about wrapping).
 */

function retryPolicy(error: unknown) {
  if (!(error instanceof EmailBisonApiError)) {
    // A network error (DNS, socket reset) has no status. Worth one more try.
    return error instanceof TypeError ? {} : null;
  }
  if (error.statusCode === 429 || error.statusCode >= 500) {
    return { statusCode: error.statusCode, retryAfterMs: error.retryAfterMs };
  }
  return null;
}

export interface EmailBisonClientOptions {
  baseUrl: string;
  apiKey: string;
}

export class EmailBisonClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor({ baseUrl, apiKey }: EmailBisonClientOptions) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    return limited(async () => {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...options.headers,
        },
        // EmailBison is an external service and this data changes constantly.
        // Caching here would silently serve stale numbers.
        cache: "no-store",
      });

      /*
       * Report the budget back to the gate on EVERY response, including error
       * ones — a 429 is exactly when the number matters most. The gate wraps an
       * opaque function and cannot see headers itself, so this is the only place
       * that can tell it how much room is left.
       */
      reportRateLimit(response.headers);

      if (!response.ok) {
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          body = await response.text().catch(() => null);
        }

        const retryAfter = response.headers.get("retry-after");
        throw new EmailBisonApiError(
          `EmailBison ${response.status} ${response.statusText} on ${endpoint}`,
          response.status,
          body,
          retryAfter ? Number(retryAfter) * 1000 : undefined,
        );
      }

      // Some writes answer 200 with an empty body (pause is one). Treat an
      // unparseable body as "no payload" rather than failing an action that
      // actually succeeded.
      const payload = await response.json().catch(() => null);
      /*
       * A 2xx is not proof the change landed. EmailBison answers some writes
       * with `success: false` in the body, and trusting the status alone would
       * report those as applied — the exact silent failure spec §9.5 forbids,
       * and the hardest kind to notice because the UI looks right while the
       * sending platform never changed. Reads never carry `success`, so this
       * costs them nothing.
       */
      assertApplied(payload, endpoint);
      return payload as T;
    }, retryPolicy);
  }

  /**
   * Walks an index endpoint to exhaustion using CURSOR pagination.
   *
   * Cursor, not page numbers, for a reason that bites silently:
   *
   *   "Traditional page based pagination is automatically limited to 1000 pages
   *    for all index routes"  — docs.emailbison.com/get-started/pagination
   *
   * Pages are a fixed 15 rows and `per_page` is IGNORED on every endpoint
   * (verified against /api/leads, /api/replies, /api/campaigns and
   * /api/sender-emails). 1000 pages x 15 is a hard ceiling of 15,000 records,
   * reached with no error and no marker — the walk just ends. Replies stand at
   * ~8,000 today, so page-based paging would have started dropping data
   * somewhere around next year with nothing in the logs to say so.
   *
   * `maxPages` stays as a genuine runaway guard against a malformed cursor that
   * never advances, and it now WARNS LOUDLY because hitting it means real data
   * was left behind.
   */
  private async fetchAllPages<T>(
    endpoint: string,
    params: Record<string, string | number> = {},
    maxPages = 8000,
  ): Promise<T[]> {
    const all: T[] = [];
    let cursor: string | null = null;
    let pages = 0;

    for (;;) {
      const query = new URLSearchParams({
        ...Object.fromEntries(
          Object.entries(params).map(([k, v]) => [k, String(v)]),
        ),
        pagination_type: "cursor",
      });
      if (cursor) query.set("cursor", cursor);

      const response: Paginated<T> = await this.request<Paginated<T>>(
        `${endpoint}?${query.toString()}`,
      );
      all.push(...(response.data ?? []));
      pages++;

      const next = response.meta?.next_cursor ?? null;
      // A null next_cursor is the documented end-of-data marker.
      if (!next) break;
      // Guard against a cursor that returns itself, which would loop forever.
      if (next === cursor) {
        console.warn(`[emailbison] ${endpoint}: cursor stopped advancing at page ${pages}`);
        break;
      }
      if (pages >= maxPages) {
        console.warn(
          `[emailbison] ${endpoint}: hit the ${maxPages}-page runaway guard — DATA WAS LEFT BEHIND`,
        );
        break;
      }
      cursor = next;
    }

    return all;
  }

  /** EmailBison sometimes wraps single resources in `{ data: ... }` and sometimes doesn't. */
  private unwrap<T extends object>(response: T | { data: T }): T {
    if (response && typeof response === "object" && "data" in response) {
      return (response as { data: T }).data;
    }
    return response as T;
  }

  // --- workspaces ------------------------------------------------------------

  /** Q1: confirms whether the token sees one workspace or several. */
  async getWorkspaces(): Promise<EBWorkspace[]> {
    const response =
      await this.request<{ data: EBWorkspace[] }>("/api/workspaces");
    return response.data ?? [];
  }

  async getWorkspaceStats(from: string, to: string) {
    return this.request<{ data: Record<string, string | number> }>(
      `/api/workspaces/v1.1/stats?start_date=${from}&end_date=${to}`,
    );
  }

  // --- campaigns -------------------------------------------------------------

  async getAllCampaigns(): Promise<EBCampaign[]> {
    return this.fetchAllPages<EBCampaign>("/api/campaigns");
  }

  async getCampaign(id: number): Promise<EBCampaign> {
    return this.unwrap(
      await this.request<EBCampaign | { data: EBCampaign }>(
        `/api/campaigns/${id}`,
      ),
    );
  }

  /**
   * Range aggregate for one campaign, including per-step stats.
   *
   * Called with `from === to` by the nightly job to build the daily table — the
   * top level feeds campaign_day_stats (total_leads_contacted is the Prospects
   * series) and sequence_step_stats feeds campaign_step_stats_daily. One call,
   * two tables. Q6 verifies a single-day range returns both correctly.
   */
  async getCampaignStats(id: number, from: string, to: string) {
    return this.request<EBCampaignStats>(`/api/campaigns/${id}/stats`, {
      method: "POST",
      body: JSON.stringify({ start_date: from, end_date: to }),
    });
  }

  // --- campaign writes --------------------------------------------------------
  // These change what real prospects receive. Every caller must record the
  // outcome in campaign_audit_log, and must never report success it didn't get.

  /** `active`/`completed` → `paused`. Returns 200 with an empty body. */
  async pauseCampaign(id: number) {
    return this.request<unknown>(`/api/campaigns/${id}/pause`, { method: "PATCH" });
  }

  /**
   * `paused` → `queued`. NOT an undo of pause.
   *
   * Probed 2026-07-31: campaign 69 went `completed` → `paused` → `queued`, i.e.
   * from finished to ready-to-email its 828 attached leads. There is no call
   * that returns it to `completed`. Callers must confirm with the lead count in
   * front of the operator. See docs/eb-api-findings.md.
   */
  async resumeCampaign(id: number) {
    return this.request<{ data?: EBCampaign }>(`/api/campaigns/${id}/resume`, {
      method: "PATCH",
    });
  }

  async archiveCampaign(id: number) {
    return this.request<unknown>(`/api/campaigns/${id}/archive`, { method: "PATCH" });
  }

  async duplicateCampaign(id: number) {
    return this.request<{ data?: EBCampaign }>(`/api/campaigns/${id}/duplicate`, {
      method: "POST",
    });
  }

  /** Settings only — name, limits, tracking flags. Never status. */
  async updateCampaign(id: number, patch: Record<string, unknown>) {
    return this.request<{ data?: EBCampaign }>(`/api/campaigns/${id}/update`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  /**
   * Tags are the ONLY genuinely bulk campaign write EmailBison offers besides
   * delete — pause, resume and archive are all per-campaign, so a bulk pause is
   * a fan-out that has to report per-item results.
   */
  async setCampaignTags(
    action: "attach" | "remove",
    tagIds: number[],
    campaignIds: number[],
  ) {
    const path =
      action === "attach" ? "/api/tags/attach-to-campaigns" : "/api/tags/remove-from-campaigns";
    return this.request<unknown>(path, {
      method: "POST",
      body: JSON.stringify({ tag_ids: tagIds, campaign_ids: campaignIds }),
    });
  }

  /**
   * Appends steps. Existing ones are untouched — there is no call that
   * replaces a sequence, which is why Replace has to delete first.
   */
  async createSequenceSteps(
    campaignId: number,
    title: string,
    steps: Array<Record<string, unknown>>,
  ) {
    return this.request<EBSequenceStepsResponse>(
      `/api/campaigns/v1.1/${campaignId}/sequence-steps`,
      { method: "POST", body: JSON.stringify({ title, sequence_steps: steps }) },
    );
  }

  /** Updates ONLY the steps listed, each of which must carry its `id`. */
  async updateSequenceSteps(
    sequenceId: number,
    title: string,
    steps: Array<Record<string, unknown>>,
  ) {
    return this.request<EBSequenceStepsResponse>(
      `/api/campaigns/v1.1/sequence-steps/${sequenceId}`,
      { method: "PUT", body: JSON.stringify({ title, sequence_steps: steps }) },
    );
  }

  async deleteSequenceStep(stepId: number) {
    return this.request<unknown>(`/api/campaigns/sequence-steps/${stepId}`, {
      method: "DELETE",
    });
  }

  async getCampaignSequenceSteps(id: number) {
    return this.request<EBSequenceStepsResponse>(
      `/api/campaigns/v1.1/${id}/sequence-steps`,
    );
  }

  // --- campaign membership: leads and inboxes ---------------------------------
  //
  // All five verified live against OpsLabs campaigns on 2026-09-09 and written
  // up in docs/eb-api-findings.md. The paths are worth reading twice: adding
  // leads is `…/leads/attach-leads`, while removing them is a DELETE on
  // `…/leads` itself, and inboxes use `attach-`/`remove-` prefixes on the
  // campaign. Being one segment out returns a plain 404 that reads exactly like
  // "EmailBison cannot do this" — which is what it cost me the first time.

  /**
   * Adds existing leads to a campaign. Idempotent: EmailBison replies
   * "Existing leads were not added" rather than duplicating them.
   *
   * THIS IS A COPY, NOT A MOVE — the leads stay in every campaign they were
   * already in. A move is this followed by `removeLeadsFromCampaign` on the
   * source, and that second call is the one that changes history.
   */
  async attachLeadsToCampaign(campaignId: number, leadIds: number[]) {
    return this.request<{ data?: { success?: boolean; message?: string } }>(
      `/api/campaigns/${campaignId}/leads/attach-leads`,
      { method: "POST", body: JSON.stringify({ lead_ids: leadIds }) },
    );
  }

  /** Attaches a whole lead list. */
  async attachLeadListToCampaign(campaignId: number, leadListId: number) {
    return this.request<{ data?: { success?: boolean; message?: string } }>(
      `/api/campaigns/${campaignId}/leads/attach-lead-list`,
      { method: "POST", body: JSON.stringify({ lead_list_id: leadListId }) },
    );
  }

  /**
   * Removes leads from THIS campaign only. The leads themselves survive, as
   * does their membership of every other campaign, and so does the send history
   * — removal stops future emails, it does not unsend past ones.
   */
  async removeLeadsFromCampaign(campaignId: number, leadIds: number[]) {
    return this.request<{ data?: { success?: boolean; message?: string } }>(
      `/api/campaigns/${campaignId}/leads`,
      { method: "DELETE", body: JSON.stringify({ lead_ids: leadIds }) },
    );
  }

  /** Idempotent: re-attaching replies "These emails already exist on this campaign". */
  async attachSenderEmails(campaignId: number, senderEmailIds: number[]) {
    return this.request<{ data?: { success?: boolean; message?: string } }>(
      `/api/campaigns/${campaignId}/attach-sender-emails`,
      { method: "POST", body: JSON.stringify({ sender_email_ids: senderEmailIds }) },
    );
  }

  async removeSenderEmails(campaignId: number, senderEmailIds: number[]) {
    return this.request<{ data?: { success?: boolean; message?: string } }>(
      `/api/campaigns/${campaignId}/remove-sender-emails`,
      { method: "DELETE", body: JSON.stringify({ sender_email_ids: senderEmailIds }) },
    );
  }

  /**
   * How many leads a campaign actually holds, in ONE call.
   *
   * The authority on what an attach or remove really did. EmailBison reports
   * `success: true` on an attach even when it silently drops leads it will not
   * accept — a `bounced` lead is refused without a word — so the only honest
   * "applied" figure is the difference in this number, never the length of the
   * array we sent.
   */
  async getCampaignLeadCount(campaignId: number): Promise<number> {
    const response = await this.request<{ meta?: { total?: number } }>(
      `/api/campaigns/${campaignId}/leads?page=1`,
    );
    return Number(response?.meta?.total ?? 0);
  }

  /** The inboxes currently sending for a campaign, all pages. */
  async getCampaignSenderEmails(campaignId: number) {
    return this.fetchAllPages<EBSenderEmail>(
      `/api/campaigns/${campaignId}/sender-emails`,
    );
  }

  /**
   * Creates an empty campaign.
   *
   * `lead_ids` and `lead_list_id` are accepted and SILENTLY IGNORED here —
   * verified. Leads go on afterwards, via attachLeadsToCampaign.
   */
  async createCampaign(name: string) {
    return this.request<{ data?: EBCampaign }>("/api/campaigns", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  async deleteCampaign(id: number) {
    return this.request<unknown>(`/api/campaigns/${id}`, { method: "DELETE" });
  }

  /**
   * The upcoming send forecast, all pages (§10).
   *
   * Paginated — 15 campaigns per page — so the single-page call this replaces
   * would silently under-report the day's volume once the workspace grew past
   * one page. It already has two.
   */
  async getAllSendingSchedules(
    day: "today" | "tomorrow" | "day_after_tomorrow" = "today",
  ): Promise<Array<{ campaign_id: number; emails_being_sent: number }>> {
    return this.fetchAllPages<{ campaign_id: number; emails_being_sent: number }>(
      "/api/campaigns/sending-schedules",
      { day },
    );
  }

  async getSendingSchedules(
    day: "today" | "tomorrow" | "day_after_tomorrow" = "today",
  ) {
    return this.request<Paginated<unknown>>(
      `/api/campaigns/sending-schedules?day=${day}`,
    );
  }

  // --- sender emails ---------------------------------------------------------

  async getAllSenderEmails(): Promise<EBSenderEmail[]> {
    return this.fetchAllPages<EBSenderEmail>("/api/sender-emails");
  }

  // --- replies ---------------------------------------------------------------

  async getRepliesPage(params: {
    page?: number;
    per_page?: number;
    campaign_id?: number;
    folder?: string;
    status?: string;
  } = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, String(value));
    }
    const qs = query.toString();
    return this.request<Paginated<EBReply>>(
      `/api/replies${qs ? `?${qs}` : ""}`,
    );
  }

  /**
   * Tracked replies for ONE campaign.
   *
   * This, not `/api/replies`, is the reply source. `/api/replies` is the master
   * inbox: ~1.9M rows, 959K of them our own outbound, most with campaign_id
   * NULL. The campaign-scoped feed returns only genuine tracked replies with a
   * real campaign_id and lead_id.
   */
  /**
   * One page of a campaign's replies, cursor-paged.
   *
   * Per-campaign rather than the global /api/replies, and that is a 17,000x
   * difference: the global endpoint holds every inbound message across every
   * sender inbox — 2,017,465 rows — of which only ~8,000 are tracked replies
   * tied to a campaign send. Walking it would be ~134,000 requests to find 0.4%
   * of what it returns.
   *
   * Cursor rather than page numbers because page mode caps at 1000 pages and
   * stops silently; `per_page` is ignored everywhere, so pages are 15 rows and
   * that ceiling is only 15,000 replies per campaign.
   */
  async getCampaignRepliesPage(campaignId: number, cursor: string | null = null) {
    const query = new URLSearchParams({ pagination_type: "cursor" });
    if (cursor) query.set("cursor", cursor);
    return this.request<Paginated<EBReply>>(
      `/api/campaigns/${campaignId}/replies?${query.toString()}`,
    );
  }

  /**
   * One page of a campaign's SENT emails, cursor-paged.
   *
   * The only source of campaign lead membership. EmailBison exposes no endpoint
   * that lists a campaign's leads — the lead list is workspace-wide and carries
   * no campaign — but every send names both, and carries the whole lead object
   * including its custom variables, so one walk gives membership and lead
   * details together with no per-lead call.
   *
   * CURSOR, not pages, for the same reason as getCampaignRepliesPage: page mode
   * caps at 1,000 pages of 15 and stops silently, and campaign 55 alone has
   * 18,575 sends. Probed 2026-08-06: campaign_ids[], pagination_type=cursor and
   * the scheduled_date_local filter all compose in one request.
   *
   * Not routed through fetchAllPages — that accumulates every row in memory and
   * offers no cursor to persist, which is exactly what a 1,239-page campaign and
   * a resumable backfill need.
   */
  async getSentEmailsPage(
    campaignId: number,
    cursor: string | null = null,
    sentOnOrAfter: string | null = null,
  ) {
    const query = new URLSearchParams({
      status: "sent",
      pagination_type: "cursor",
    });
    query.set("campaign_ids[]", String(campaignId));
    if (cursor) query.set("cursor", cursor);
    if (sentOnOrAfter) {
      query.set("scheduled_date_local[criteria]", ">=");
      query.set("scheduled_date_local[value]", sentOnOrAfter);
    }
    return this.request<Paginated<EBSentEmail>>(`/api/scheduled-emails?${query.toString()}`);
  }

  /**
   * One lead, by id.
   *
   * This is how the Replies view gets its attributes, rather than walking the
   * whole list. Pages are a fixed 15 rows, so a full walk of 69,794 leads is
   * 4,653 SERIAL requests (~25 min, because a cursor cannot be parallelised).
   * Fetching the 6,675 people who have actually replied runs at the client's
   * concurrency of 4, and after the first backfill only new repliers are
   * fetched — which makes the nightly run seconds rather than minutes.
   */
  async getLead(id: number): Promise<EBLead | null> {
    try {
      return this.unwrap(await this.request<EBLead | { data: EBLead }>(`/api/leads/${id}`));
    } catch (error) {
      // A lead deleted in EmailBison is a 404, which is an answer, not a fault.
      if (error instanceof EmailBisonApiError && error.statusCode === 404) return null;
      throw error;
    }
  }

  /**
   * Finds leads by an arbitrary term — used with an email address to resolve an
   * outcome back to the campaign that first contacted that person.
   */
  async searchLeads(term: string): Promise<Array<{ id: number; email?: string }>> {
    const response = await this.request<{ data?: Array<{ id: number; email?: string }> }>(
      `/api/leads?search=${encodeURIComponent(term)}&per_page=5`,
    );
    return response?.data ?? [];
  }

  /** Sends made to one lead — the source for first_send_at (Median Reply Time). */
  async getLeadSentEmails(leadId: number) {
    return this.request<{ data?: Array<Record<string, unknown>> }>(
      `/api/leads/${leadId}/sent-emails`,
    );
  }

  /** Both reply timings in one call. See the Q16 note in types.ts. */
  async getConversationThread(replyId: number) {
    return this.request<EBConversationThread>(
      `/api/replies/${replyId}/conversation-thread`,
    );
  }

  // --- daily series ----------------------------------------------------------
  // Raw transport only. Endpoint selection and label mapping live in
  // daily-series.ts so there is exactly one place to change if EB moves them.

  async getDailySeries(
    path: string,
    query: URLSearchParams,
  ): Promise<EBDailySeriesResponse> {
    return this.request<EBDailySeriesResponse>(`${path}?${query.toString()}`);
  }
}

/** Builds a client from the environment. Server-only. */
export function createEmailBisonClient(): EmailBisonClient {
  const baseUrl = (
    process.env.EMAILBISON_BASE_URL || "https://send.brokerstaffer.com"
  ).replace(/\/$/, "");
  const apiKey = process.env.EMAILBISON_API_KEY;

  if (!apiKey) {
    throw new Error(
      "EMAILBISON_API_KEY is not set. See .env.example.",
    );
  }

  return new EmailBisonClient({ baseUrl, apiKey });
}
