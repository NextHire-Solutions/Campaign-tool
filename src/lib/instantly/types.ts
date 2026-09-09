/*
 * Instantly v2 shapes, only the fields this app reads.
 *
 * Everything here was observed on the live workspace on 2026-09-09 and is
 * recorded in docs/instantly-api-findings.md.
 */

/** A page of results. `next_starting_after` is null on the last page. */
export interface InstantlyPage<T> {
  items: T[];
  next_starting_after?: string | null;
}

export interface InstantlyCampaign {
  id: string;
  name: string;
  /** 0 draft · 1 active · 2 paused · 3 completed · -1/-2 error states. */
  status: number;
  timestamp_created?: string;
  timestamp_updated?: string;
  campaign_schedule?: unknown;
}

/**
 * Per-campaign metrics. `GET /campaigns/analytics` returns these for EVERY
 * campaign in one call — no fan-out, unlike EmailBison.
 */
export interface InstantlyCampaignAnalytics {
  campaign_id: string;
  campaign_name: string;
  campaign_status: number;
  campaign_is_evergreen?: boolean;
  leads_count?: number;
  contacted_count?: number;
  emails_sent_count?: number;
  new_leads_contacted_count?: number;
  open_count?: number;
  open_count_unique?: number;
  reply_count?: number;
  reply_count_unique?: number;
  reply_count_automatic?: number;
  link_click_count?: number;
  bounced_count?: number;
  unsubscribed_count?: number;
  completed_count?: number;
  total_opportunities?: number;
  total_opportunity_value?: number;
}

/** One day of a campaign's (or the workspace's) activity. */
export interface InstantlyDailyRow {
  date: string;
  sent: number;
  contacted: number;
  new_leads_contacted: number;
  opened: number;
  unique_opened: number;
  replies: number;
  unique_replies: number;
  replies_automatic: number;
  unique_replies_automatic: number;
  clicks: number;
  unique_clicks: number;
  opportunities: number;
  unique_opportunities: number;
}

/** A sending inbox. Keyed by EMAIL, not by an id. */
export interface InstantlyAccount {
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  organization?: string | null;
  /** 1 active · 2 paused · -1/-2/-3 error states. */
  status?: number;
  warmup_status?: number;
  provider_code?: number;
  daily_limit?: number;
  timestamp_created?: string;
  timestamp_updated?: string;
}

/** A message in the unibox. Replies are the ones we care about. */
export interface InstantlyEmail {
  id: string;
  timestamp_created: string;
  timestamp_email?: string;
  message_id?: string;
  subject?: string | null;
  content_preview?: string | null;
  eaccount?: string | null;
  from_address_email?: string | null;
  campaign_id?: string | null;
  /** The lead's EMAIL ADDRESS, not an id. */
  lead?: string | null;
  ue_type?: number | null;
  step?: number | null;
  thread_id?: string | null;
  /** Instantly's own interest signal: 1 / -1 / absent. Not our sentiment authority. */
  i_status?: number | null;
  ai_interest_value?: number | null;
}
