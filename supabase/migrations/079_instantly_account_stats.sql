-- 079 — per-inbox sending figures for Instantly, so Infrastructure can hold
-- both estates.
--
-- Infrastructure's whole job is "which inbox is bouncing", and Instantly's
-- account list carries no send or bounce counters at all — only email, status,
-- daily limit and warmup state. Without per-inbox figures its 536 accounts
-- could be listed but never ranked, which is the one thing that page is for.
--
-- /accounts/analytics/daily supplies them: one row per account per day with
-- sent, bounced, contacted, replies, opens and clicks. Two hard limits, both
-- found by hitting them:
--
--   * a range may not exceed 31 DAYS (400 beyond that)
--   * at most 200 EMAILS per request (400 at 300; a 536-email querystring is
--     rejected outright with 431 Request Header Fields Too Large)
--
-- So a full sweep is ceil(536/180) = 3 calls per 31-day window, and it is
-- quick: 150 accounts over 26 days came back in half a second.
--
-- LIFETIME IS DERIVED HERE, NOT FETCHED. EmailBison hands us a lifetime counter
-- per inbox; Instantly has none, so "lifetime" for an Instantly account means
-- "everything we have synced". That is a real difference and the Infrastructure
-- view must not pretend otherwise — an account with no rows yet has NULL
-- totals, not zero, because we have not looked rather than found nothing.

BEGIN;

CREATE TABLE IF NOT EXISTS instantly_account_day_stats (
  email       TEXT NOT NULL,
  team_id     BIGINT NOT NULL,
  stat_date   DATE NOT NULL,
  sent        INTEGER NOT NULL DEFAULT 0,
  bounced     INTEGER NOT NULL DEFAULT 0,
  contacted   INTEGER NOT NULL DEFAULT 0,
  replies     INTEGER NOT NULL DEFAULT 0,
  unique_replies INTEGER NOT NULL DEFAULT 0,
  opened      INTEGER NOT NULL DEFAULT 0,
  clicks      INTEGER NOT NULL DEFAULT 0,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (email, stat_date)
);

CREATE INDEX IF NOT EXISTS idx_inst_acct_days
  ON instantly_account_day_stats (team_id, stat_date);

ALTER TABLE instantly_account_day_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE instantly_account_day_stats FORCE  ROW LEVEL SECURITY;
REVOKE ALL ON instantly_account_day_stats FROM anon, authenticated;

/*
 * The Instantly half of the sending estate, shaped like analytics_sender_rows
 * so the Infrastructure table can render both from one component.
 *
 * `sent`/`bounced` are NULL — not 0 — for an account we hold no day rows for.
 * Zero would put it in the healthy band and count silence as good news, which
 * is the same reasoning that keeps never-sent EmailBison inboxes out of every
 * band (058).
 */
CREATE OR REPLACE FUNCTION analytics_instantly_account_rows(
  p_team_id  BIGINT,
  p_search   TEXT    DEFAULT NULL,
  p_min_sent INTEGER DEFAULT 0,
  p_limit    INTEGER DEFAULT 200,
  p_offset   INTEGER DEFAULT 0
)
RETURNS TABLE (
  email       TEXT,
  domain      TEXT,
  status      INTEGER,
  daily_limit INTEGER,
  sent        BIGINT,
  bounced     BIGINT,
  replied     BIGINT,
  bounce_rate NUMERIC,
  reply_rate  NUMERIC,
  total_count BIGINT
)
LANGUAGE sql STABLE AS $function$
  WITH rolled AS (
    SELECT d.email,
           SUM(d.sent)::BIGINT           AS sent,
           SUM(d.bounced)::BIGINT        AS bounced,
           SUM(d.unique_replies)::BIGINT AS replied
    FROM instantly_account_day_stats d
    WHERE d.team_id = p_team_id
    GROUP BY 1
  ),
  joined AS (
    SELECT a.email, a.domain, a.status, a.daily_limit,
           r.sent, r.bounced, r.replied
    FROM instantly_accounts a
    LEFT JOIN rolled r ON r.email = a.email
    WHERE a.team_id = p_team_id
      AND a.archived_at IS NULL
      AND (p_search IS NULL
           OR a.email ILIKE '%' || p_search || '%'
           OR COALESCE(a.domain, '') ILIKE '%' || p_search || '%')
      AND COALESCE(r.sent, 0) >= p_min_sent
  )
  SELECT
    j.email, j.domain, j.status, j.daily_limit,
    j.sent, j.bounced, j.replied,
    CASE WHEN COALESCE(j.sent, 0) > 0 THEN j.bounced::NUMERIC / j.sent END,
    CASE WHEN COALESCE(j.sent, 0) > 0 THEN j.replied::NUMERIC / j.sent END,
    COUNT(*) OVER ()
  FROM joined j
  ORDER BY COALESCE(j.sent, 0) DESC, j.email
  LIMIT p_limit OFFSET p_offset;
$function$;

/** The same, rolled to a domain — the Infrastructure "Domain" view. */
CREATE OR REPLACE FUNCTION analytics_instantly_account_groups(
  p_team_id   BIGINT,
  p_min_total INTEGER DEFAULT 0
)
RETURNS TABLE (
  label       TEXT,
  inboxes     BIGINT,
  sent        BIGINT,
  bounced     BIGINT,
  replied     BIGINT,
  bounce_rate NUMERIC,
  reply_rate  NUMERIC
)
LANGUAGE sql STABLE AS $function$
  WITH rolled AS (
    SELECT d.email, SUM(d.sent)::BIGINT s, SUM(d.bounced)::BIGINT b,
           SUM(d.unique_replies)::BIGINT r
    FROM instantly_account_day_stats d WHERE d.team_id = p_team_id GROUP BY 1
  ),
  grouped AS (
    SELECT COALESCE(a.domain, 'unknown') AS label,
           COUNT(*)                      AS inboxes,
           COALESCE(SUM(x.s), 0)         AS sent,
           COALESCE(SUM(x.b), 0)         AS bounced,
           COALESCE(SUM(x.r), 0)         AS replied
    FROM instantly_accounts a
    LEFT JOIN rolled x ON x.email = a.email
    WHERE a.team_id = p_team_id AND a.archived_at IS NULL
    GROUP BY 1
    HAVING COALESCE(SUM(x.s), 0) >= p_min_total
  )
  SELECT g.label, g.inboxes, g.sent, g.bounced, g.replied,
         CASE WHEN g.sent > 0 THEN g.bounced::NUMERIC / g.sent END,
         CASE WHEN g.sent > 0 THEN g.replied::NUMERIC / g.sent END
  FROM grouped g
  ORDER BY g.sent DESC;
$function$;

INSERT INTO schema_migrations (version) VALUES ('079_instantly_account_stats')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
