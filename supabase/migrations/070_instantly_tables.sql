-- 070 — Instantly, in its own tables.
--
-- Instantly is the LARGER half of the operation and none of it reached this
-- dashboard: 317 campaigns, 536 inboxes, 840,416 sends and 22,685 replies,
-- against EmailBison's 180 / 1,496 / ~435,000 / ~5,700. The KPI band has been
-- describing under a third of the sending.
--
-- ---------------------------------------------------------------------------
-- WHY PARALLEL TABLES AND NOT A `platform` COLUMN.
--
-- Every existing table is keyed on EmailBison's INTEGER ids — campaigns.id,
-- leads.id, sender_emails.id are all BIGINT. Instantly is UUID-keyed, and its
-- accounts are keyed by email address with no id at all. There is no way to put
-- both in one table without re-keying the tables that every current metric
-- reads from, and doing that would put ~30 working RPCs and every number that
-- is correct today at risk in a single migration.
--
-- Separate tables cost a union in the read layer. That union is additive: an
-- RPC that does not know about Instantly keeps returning exactly what it
-- returned yesterday, which is the property that makes this safe to ship.
--
-- ---------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT HERE.
--
-- No sentiment column on instantly_replies beyond Instantly's own `i_status`.
-- MasterInbox labels are the sentiment authority (046/048), and the reason
-- Positive was wrong for months was a second opinion being trusted. Instantly's
-- `i_status` is stored as EVIDENCE, under its own name, and no view reads it as
-- Positive.
--
-- No opens. `open_count` is 0 across the entire Instantly workspace because
-- open tracking is off, exactly as on EmailBison. The column exists so the sync
-- is faithful; nothing may render it as a real zero (rule 1).

BEGIN;

-- --------------------------------------------------------------------------
-- Campaigns
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS instantly_campaigns (
  id                UUID PRIMARY KEY,
  team_id           BIGINT NOT NULL,
  name              TEXT NOT NULL,
  -- 0 draft · 1 active · 2 paused · 3 completed · -1/-2 error.
  status            INTEGER,
  is_evergreen      BOOLEAN,
  -- Lifetime counters from /campaigns/analytics, refreshed whole each sync.
  leads_count       INTEGER,
  contacted_count   INTEGER,
  emails_sent       INTEGER,
  reply_count       INTEGER,
  reply_count_unique INTEGER,
  reply_count_automatic INTEGER,
  bounced_count     INTEGER,
  unsubscribed_count INTEGER,
  completed_count   INTEGER,
  opportunities     INTEGER,
  opportunity_value NUMERIC,
  eb_created_at     TIMESTAMPTZ,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Set when a campaign stops coming back from the API, the same reconciliation
  -- sync-senders needed (060): without it a deleted campaign lingers for ever
  -- and every total quietly includes it.
  archived_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_inst_campaigns_live
  ON instantly_campaigns (team_id) WHERE archived_at IS NULL;

-- --------------------------------------------------------------------------
-- Per-day, per-campaign. The chart and every windowed total read this.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS instantly_campaign_day_stats (
  campaign_id       UUID NOT NULL,
  team_id           BIGINT NOT NULL,
  stat_date         DATE NOT NULL,
  sent              INTEGER NOT NULL DEFAULT 0,
  contacted         INTEGER NOT NULL DEFAULT 0,
  new_leads_contacted INTEGER NOT NULL DEFAULT 0,
  opened            INTEGER NOT NULL DEFAULT 0,
  unique_opened     INTEGER NOT NULL DEFAULT 0,
  replies           INTEGER NOT NULL DEFAULT 0,
  unique_replies    INTEGER NOT NULL DEFAULT 0,
  replies_automatic INTEGER NOT NULL DEFAULT 0,
  clicks            INTEGER NOT NULL DEFAULT 0,
  opportunities     INTEGER NOT NULL DEFAULT 0,
  fetched_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, stat_date)
);

CREATE INDEX IF NOT EXISTS idx_inst_days
  ON instantly_campaign_day_stats (team_id, stat_date);

-- --------------------------------------------------------------------------
-- Accounts (inboxes). Keyed by EMAIL — Instantly gives them no id.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS instantly_accounts (
  email             TEXT PRIMARY KEY,
  team_id           BIGINT NOT NULL,
  first_name        TEXT,
  last_name         TEXT,
  domain            TEXT,
  -- 1 active · 2 paused · negative values are error states.
  status            INTEGER,
  warmup_status     INTEGER,
  provider_code     INTEGER,
  daily_limit       INTEGER,
  eb_created_at     TIMESTAMPTZ,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_inst_accounts_live
  ON instantly_accounts (team_id) WHERE archived_at IS NULL;

-- --------------------------------------------------------------------------
-- Replies
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS instantly_replies (
  id                UUID PRIMARY KEY,
  team_id           BIGINT NOT NULL,
  campaign_id       UUID,
  /*
   * The lead's EMAIL, because that is all Instantly gives — there is no lead id
   * on a message. It is also the only join back to anything else we hold.
   */
  lead_email        TEXT,
  from_email        TEXT,
  eaccount          TEXT,
  subject           TEXT,
  preview           TEXT,
  thread_id         TEXT,
  step              INTEGER,
  ue_type           INTEGER,
  /*
   * Instantly's own interest signal (1 / -1 / null). EVIDENCE, NOT SENTIMENT.
   * MasterInbox labels decide Positive here; trusting a platform's own guess is
   * exactly what made Positive wrong for months (046/048).
   */
  i_status          INTEGER,
  ai_interest_value INTEGER,
  received_at       TIMESTAMPTZ,
  received_date     DATE,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inst_replies_date
  ON instantly_replies (team_id, received_date);
CREATE INDEX IF NOT EXISTS idx_inst_replies_campaign
  ON instantly_replies (campaign_id, received_date);
CREATE INDEX IF NOT EXISTS idx_inst_replies_lead
  ON instantly_replies (lead_email);

-- --------------------------------------------------------------------------
-- Locked down exactly like every other table here: service role only.
-- --------------------------------------------------------------------------

ALTER TABLE instantly_campaigns           ENABLE ROW LEVEL SECURITY;
ALTER TABLE instantly_campaigns           FORCE  ROW LEVEL SECURITY;
ALTER TABLE instantly_campaign_day_stats  ENABLE ROW LEVEL SECURITY;
ALTER TABLE instantly_campaign_day_stats  FORCE  ROW LEVEL SECURITY;
ALTER TABLE instantly_accounts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE instantly_accounts            FORCE  ROW LEVEL SECURITY;
ALTER TABLE instantly_replies             ENABLE ROW LEVEL SECURITY;
ALTER TABLE instantly_replies             FORCE  ROW LEVEL SECURITY;

REVOKE ALL ON instantly_campaigns          FROM anon, authenticated;
REVOKE ALL ON instantly_campaign_day_stats FROM anon, authenticated;
REVOKE ALL ON instantly_accounts           FROM anon, authenticated;
REVOKE ALL ON instantly_replies            FROM anon, authenticated;

INSERT INTO schema_migrations (version) VALUES ('070_instantly_tables')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
