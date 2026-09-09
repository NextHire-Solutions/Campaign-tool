-- 074 — Instantly's numbers, in the shapes the dashboard already reads.
--
-- Deliberately NEW functions rather than edits to the EmailBison ones. That is
-- the whole safety property of the parallel-table decision: analytics_kpis,
-- analytics_campaign_rows and analytics_timeseries keep returning exactly what
-- they returned yesterday, and the routes decide whether to add Instantly on
-- top. Nothing that is correct today can be broken by this migration.
--
-- ---------------------------------------------------------------------------
-- WHAT INSTANTLY CAN AND CANNOT ANSWER, AND WHY SOME COLUMNS ARE NULL.
--
-- * SENT, PROSPECTS, REPLIES come from the per-day series, which is a true
--   daily breakdown and sums exactly to the ranged totals (verified 942 = 942,
--   and 1,728 = 1,728 across the workspace).
--
-- * BOUNCES ARE NULL FOR A DATE RANGE, and that is not laziness. Instantly's
--   daily series carries no bounce field at all — bounced_count exists only as
--   a LIFETIME figure per campaign. Dividing a lifetime bounce count into a
--   window would be inventing a number; showing 0 would state that nothing
--   bounced. NULL reaches the DOM as a dash (rule 1), which is the truth: we
--   know the lifetime figure and not the windowed one.
--
-- * POSITIVE IS NULL. MasterInbox labels decide Positive here (046/048) and
--   they are keyed to EmailBison reply ids, so no Instantly reply carries one
--   yet. Instantly's own `i_status` is stored as evidence but must NOT be read
--   as Positive: a second opinion silently feeding that number is exactly what
--   made Positive wrong for months. Instantly outcomes DO already reach the
--   product through the MasterInbox outcomes feed, which is a different and
--   correct path.
--
-- * OPENS are omitted entirely. open_count is 0 across the whole workspace
--   because tracking is off, the same as EmailBison.
--
-- HUMAN REPLIES = replies − automatic. Instantly counts auto-replies
-- separately (954 workspace-wide), which is the same distinction EmailBison's
-- `tracked_reply` draws, so the two platforms mean the same thing by it.

BEGIN;

/*
 * Which Instantly campaigns are in scope, applying the same client and
 * exclusion rules the EmailBison side uses.
 */
CREATE OR REPLACE FUNCTION instantly_scoped_campaigns(
  p_team_id      BIGINT,
  p_client_ids   UUID[]   DEFAULT NULL,
  p_campaign_ids UUID[]   DEFAULT NULL
)
RETURNS TABLE (id UUID)
LANGUAGE sql STABLE AS $function$
  SELECT c.id
  FROM instantly_campaigns c
  LEFT JOIN instantly_campaign_clients cc ON cc.campaign_id = c.id
  WHERE c.team_id = p_team_id
    AND c.archived_at IS NULL
    AND COALESCE(cc.excluded, FALSE) = FALSE
    AND (p_campaign_ids IS NULL OR c.id = ANY(p_campaign_ids))
    AND (p_client_ids   IS NULL OR cc.client_id = ANY(p_client_ids));
$function$;

/*
 * The KPI band's Instantly half. Same column names as analytics_kpis so a
 * caller can add the two together without a translation layer.
 */
CREATE OR REPLACE FUNCTION analytics_instantly_kpis(
  p_team_id      BIGINT,
  p_from         DATE,
  p_to           DATE,
  p_client_ids   UUID[]   DEFAULT NULL,
  p_campaign_ids UUID[]   DEFAULT NULL
)
RETURNS TABLE (
  sent          BIGINT,
  prospects     BIGINT,
  replies       BIGINT,
  human_replies BIGINT,
  positive      BIGINT,
  bounces       BIGINT
)
LANGUAGE sql STABLE AS $function$
  WITH scoped AS (
    SELECT id FROM instantly_scoped_campaigns(p_team_id, p_client_ids, p_campaign_ids)
  )
  SELECT
    COALESCE(SUM(d.sent), 0),
    -- new_leads_contacted is people reached for the FIRST time in the window,
    -- which is what Prospects means on the EmailBison side too.
    COALESCE(SUM(d.new_leads_contacted), 0),
    COALESCE(SUM(d.unique_replies), 0),
    COALESCE(SUM(d.unique_replies), 0) - COALESCE(SUM(d.replies_automatic), 0),
    -- NULL, not 0: MasterInbox owns Positive and has no labels for Instantly.
    NULL::BIGINT,
    -- NULL, not 0: Instantly publishes no per-day bounce figure at all.
    NULL::BIGINT
  FROM instantly_campaign_day_stats d
  WHERE d.team_id = p_team_id
    AND d.stat_date BETWEEN p_from AND p_to
    AND d.campaign_id IN (SELECT id FROM scoped);
$function$;

/*
 * One row per Instantly campaign for the Campaigns table.
 *
 * `bounces` here IS available, because it is the campaign's lifetime figure
 * rather than a windowed one — and it is labelled as lifetime in the column so
 * it cannot be read as belonging to the date range.
 */
CREATE OR REPLACE FUNCTION analytics_instantly_campaign_rows(
  p_team_id      BIGINT,
  p_from         DATE,
  p_to           DATE,
  p_client_ids   UUID[]   DEFAULT NULL,
  p_campaign_ids UUID[]   DEFAULT NULL
)
RETURNS TABLE (
  campaign_id     UUID,
  campaign_name   TEXT,
  client_id       UUID,
  client_name     TEXT,
  status          INTEGER,
  sent            BIGINT,
  prospects       BIGINT,
  replies         BIGINT,
  human_replies   BIGINT,
  lifetime_bounces BIGINT,
  reply_rate      NUMERIC
)
LANGUAGE sql STABLE AS $function$
  WITH scoped AS (
    SELECT id FROM instantly_scoped_campaigns(p_team_id, p_client_ids, p_campaign_ids)
  ),
  windowed AS (
    SELECT
      d.campaign_id,
      SUM(d.sent)                AS sent,
      SUM(d.new_leads_contacted) AS prospects,
      SUM(d.unique_replies)      AS replies,
      SUM(d.replies_automatic)   AS automatic
    FROM instantly_campaign_day_stats d
    WHERE d.team_id = p_team_id
      AND d.stat_date BETWEEN p_from AND p_to
      AND d.campaign_id IN (SELECT id FROM scoped)
    GROUP BY 1
  )
  SELECT
    c.id,
    c.name,
    cc.client_id,
    cl.name,
    c.status,
    COALESCE(w.sent, 0),
    COALESCE(w.prospects, 0),
    COALESCE(w.replies, 0),
    COALESCE(w.replies, 0) - COALESCE(w.automatic, 0),
    c.bounced_count::BIGINT,
    CASE WHEN COALESCE(w.sent, 0) > 0
         THEN COALESCE(w.replies, 0)::NUMERIC / w.sent END
  FROM instantly_campaigns c
  JOIN scoped s ON s.id = c.id
  LEFT JOIN instantly_campaign_clients cc ON cc.campaign_id = c.id
  LEFT JOIN clients cl ON cl.id = cc.client_id
  LEFT JOIN windowed w ON w.campaign_id = c.id
  -- Campaigns with no activity in the window sort last rather than vanishing:
  -- "this client's campaign sent nothing" is an answer, not an absence.
  ORDER BY COALESCE(w.sent, 0) DESC, c.name;
$function$;

/*
 * The daily series, in the same date/metric/value shape the chart already
 * consumes, so adding Instantly is a union rather than a new chart.
 */
CREATE OR REPLACE FUNCTION analytics_instantly_timeseries(
  p_team_id      BIGINT,
  p_from         DATE,
  p_to           DATE,
  p_client_ids   UUID[]   DEFAULT NULL,
  p_campaign_ids UUID[]   DEFAULT NULL
)
RETURNS TABLE (day DATE, sent BIGINT, prospects BIGINT, replies BIGINT, human_replies BIGINT)
LANGUAGE sql STABLE AS $function$
  WITH scoped AS (
    SELECT id FROM instantly_scoped_campaigns(p_team_id, p_client_ids, p_campaign_ids)
  )
  SELECT
    d.stat_date,
    SUM(d.sent)::BIGINT,
    SUM(d.new_leads_contacted)::BIGINT,
    SUM(d.unique_replies)::BIGINT,
    (SUM(d.unique_replies) - SUM(d.replies_automatic))::BIGINT
  FROM instantly_campaign_day_stats d
  WHERE d.team_id = p_team_id
    AND d.stat_date BETWEEN p_from AND p_to
    AND d.campaign_id IN (SELECT id FROM scoped)
  GROUP BY d.stat_date
  ORDER BY d.stat_date;
$function$;

INSERT INTO schema_migrations (version) VALUES ('074_instantly_analytics')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
