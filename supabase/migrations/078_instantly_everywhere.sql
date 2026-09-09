-- 078 — Instantly in every place EmailBison appears.
--
-- Bounces are now real (077), so the KPI band no longer has to dash them. That
-- leaves Positive as the ONLY metric Instantly cannot answer, and the reason is
-- worth restating because it is not a gap to be closed by more syncing:
-- MasterInbox labels decide Positive (046/048) and key on EmailBison reply ids.
-- Until MasterInbox labels Instantly threads, no amount of Instantly data
-- produces a Positive figure, and inventing one from `i_status` would repeat
-- exactly the mistake that left Positive wrong for months.
--
-- Everything else — sent, prospects, replies, human replies, bounces — is now
-- available on both platforms and means the same thing on each.

BEGIN;

DROP FUNCTION IF EXISTS analytics_instantly_kpis(BIGINT, DATE, DATE, UUID[], UUID[]);

CREATE FUNCTION analytics_instantly_kpis(
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
    COALESCE(SUM(d.new_leads_contacted), 0),
    COALESCE(SUM(d.unique_replies), 0),
    COALESCE(SUM(d.unique_replies), 0) - COALESCE(SUM(d.replies_automatic), 0),
    -- Still NULL, and not for want of data: MasterInbox owns Positive.
    NULL::BIGINT,
    /*
     * Real now. NULL only where every row in range predates 077 and genuinely
     * has no bounce figure — SUM ignores NULLs, so a window that is entirely
     * old rows must not report 0 as though nothing bounced.
     */
    CASE WHEN COUNT(d.bounced) > 0 THEN COALESCE(SUM(d.bounced), 0) END
  FROM instantly_campaign_day_stats d
  WHERE d.team_id = p_team_id
    AND d.stat_date BETWEEN p_from AND p_to
    AND d.campaign_id IN (SELECT id FROM scoped);
$function$;

/*
 * Per-campaign rows, now with WINDOWED bounces rather than a lifetime count.
 * The old column was named lifetime_bounces precisely because it could not be
 * windowed; it can now, so it is renamed and means what the date range says.
 */
DROP FUNCTION IF EXISTS analytics_instantly_campaign_rows(BIGINT, DATE, DATE, UUID[], UUID[]);

CREATE FUNCTION analytics_instantly_campaign_rows(
  p_team_id      BIGINT,
  p_from         DATE,
  p_to           DATE,
  p_client_ids   UUID[]   DEFAULT NULL,
  p_campaign_ids UUID[]   DEFAULT NULL
)
RETURNS TABLE (
  campaign_id   UUID,
  campaign_name TEXT,
  client_id     UUID,
  client_name   TEXT,
  status        INTEGER,
  sent          BIGINT,
  prospects     BIGINT,
  replies       BIGINT,
  human_replies BIGINT,
  bounces       BIGINT,
  reply_rate    NUMERIC,
  bounce_rate   NUMERIC
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
      SUM(d.replies_automatic)   AS automatic,
      SUM(d.bounced)             AS bounced
    FROM instantly_campaign_day_stats d
    WHERE d.team_id = p_team_id
      AND d.stat_date BETWEEN p_from AND p_to
      AND d.campaign_id IN (SELECT id FROM scoped)
    GROUP BY 1
  )
  SELECT
    c.id, c.name, cc.client_id, cl.name, c.status,
    COALESCE(w.sent, 0),
    COALESCE(w.prospects, 0),
    COALESCE(w.replies, 0),
    COALESCE(w.replies, 0) - COALESCE(w.automatic, 0),
    w.bounced,
    CASE WHEN COALESCE(w.sent, 0) > 0 THEN COALESCE(w.replies, 0)::NUMERIC / w.sent END,
    CASE WHEN COALESCE(w.sent, 0) > 0 AND w.bounced IS NOT NULL
         THEN w.bounced::NUMERIC / w.sent END
  FROM instantly_campaigns c
  JOIN scoped s ON s.id = c.id
  LEFT JOIN instantly_campaign_clients cc ON cc.campaign_id = c.id
  LEFT JOIN clients cl ON cl.id = cc.client_id
  LEFT JOIN windowed w ON w.campaign_id = c.id
  ORDER BY COALESCE(w.sent, 0) DESC, c.name;
$function$;

/*
 * One row per client, so the Clients table can add Instantly to the same line
 * rather than showing a client twice.
 */
CREATE OR REPLACE FUNCTION analytics_instantly_client_rows(
  p_team_id    BIGINT,
  p_from       DATE,
  p_to         DATE,
  p_client_ids UUID[] DEFAULT NULL
)
RETURNS TABLE (
  client_id     UUID,
  client_name   TEXT,
  campaigns     BIGINT,
  sent          BIGINT,
  prospects     BIGINT,
  replies       BIGINT,
  human_replies BIGINT,
  bounces       BIGINT
)
LANGUAGE sql STABLE AS $function$
  SELECT
    cc.client_id,
    -- Unassigned is a real bucket: 84 Instantly campaigns belong to clients the
    -- portal roster does not contain, and hiding them would lose 128K sends.
    COALESCE(cl.name, 'Unassigned'),
    COUNT(DISTINCT d.campaign_id),
    COALESCE(SUM(d.sent), 0),
    COALESCE(SUM(d.new_leads_contacted), 0),
    COALESCE(SUM(d.unique_replies), 0),
    COALESCE(SUM(d.unique_replies), 0) - COALESCE(SUM(d.replies_automatic), 0),
    CASE WHEN COUNT(d.bounced) > 0 THEN COALESCE(SUM(d.bounced), 0) END
  FROM instantly_campaign_day_stats d
  JOIN instantly_campaigns c                ON c.id = d.campaign_id
  LEFT JOIN instantly_campaign_clients cc   ON cc.campaign_id = d.campaign_id
  LEFT JOIN clients cl                      ON cl.id = cc.client_id
  WHERE d.team_id = p_team_id
    AND d.stat_date BETWEEN p_from AND p_to
    AND c.archived_at IS NULL
    AND COALESCE(cc.excluded, FALSE) = FALSE
    AND (p_client_ids IS NULL OR cc.client_id = ANY(p_client_ids))
  GROUP BY 1, 2
  ORDER BY COALESCE(SUM(d.sent), 0) DESC;
$function$;

INSERT INTO schema_migrations (version) VALUES ('078_instantly_everywhere')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
