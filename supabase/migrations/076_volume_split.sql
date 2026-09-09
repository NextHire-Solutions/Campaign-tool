-- 076 — how much sending capacity exists, and where the volume goes.
--
-- Client feedback: "show Total Volume available and a pie or chart of volume
-- split among clients/campaign".
--
-- Two different questions, answered by two different shapes:
--
--   CAPACITY is one number and a ratio — a stat tile, not a chart. Summed from
--   the inboxes' own daily limits: 24,655/day across EmailBison's connected
--   inboxes plus 11,065/day across Instantly's, against roughly 8,985/day
--   actually sent. A quarter of the estate is in use.
--
--   THE SPLIT is magnitude across ~40 named clients, which is a ranked bar and
--   emphatically not a pie: forty slices cannot be compared by angle and the
--   tail becomes slivers with no room for a label. Same data, legible.
--
-- DISCONNECTED INBOXES ARE EXCLUDED FROM CAPACITY. An inbox that cannot connect
-- cannot send, so counting its daily limit would overstate what is actually
-- available — the same reasoning that keeps them out of a tag assignment (060).
-- The gap is reported rather than hidden, because "555 a day sitting in dead
-- inboxes" is the actionable half of the number.

BEGIN;

/*
 * Daily sending capacity, per platform, and what is unavailable.
 *
 * A row per platform rather than one total, so the tile can say where the
 * capacity lives — the two estates are managed separately and a single figure
 * would hide that Instantly holds a third of it.
 */
CREATE OR REPLACE FUNCTION analytics_sending_capacity(p_team_id BIGINT)
RETURNS TABLE (platform TEXT, inboxes BIGINT, daily_capacity BIGINT, unavailable BIGINT)
LANGUAGE sql STABLE AS $function$
  SELECT
    'emailbison'::TEXT,
    COUNT(*) FILTER (WHERE s.status = 'Connected'),
    COALESCE(SUM(s.daily_limit) FILTER (WHERE s.status = 'Connected'), 0)::BIGINT,
    COALESCE(SUM(s.daily_limit) FILTER (WHERE s.status IS DISTINCT FROM 'Connected'), 0)::BIGINT
  FROM sender_emails s
  WHERE s.team_id = p_team_id AND s.archived_at IS NULL

  UNION ALL

  SELECT
    'instantly'::TEXT,
    COUNT(*),
    COALESCE(SUM(a.daily_limit), 0)::BIGINT,
    /*
     * Zero, deliberately. Instantly reports every account as status 2 while the
     * workspace is demonstrably sending (786 emails on 2026-09-08), so its
     * status cannot be used to call an inbox unavailable — see
     * docs/instantly-api-findings.md. Claiming otherwise would put a large
     * false "unavailable" figure on screen.
     */
    0::BIGINT
  FROM instantly_accounts a
  WHERE a.team_id = p_team_id AND a.archived_at IS NULL;
$function$;

/*
 * Volume for the window, split by client or by campaign, across both platforms.
 *
 * `platform` rides on every row so a stacked or filtered view is possible
 * later without changing the signature — and so a client that sends on both
 * appears once per platform rather than being silently merged into a total
 * that no single system could reproduce.
 */
CREATE OR REPLACE FUNCTION analytics_volume_split(
  p_team_id    BIGINT,
  p_from       DATE,
  p_to         DATE,
  p_group      TEXT     DEFAULT 'client',   -- client | campaign
  p_client_ids UUID[]   DEFAULT NULL,
  p_limit      INTEGER  DEFAULT 25
)
RETURNS TABLE (label TEXT, platform TEXT, sent BIGINT, grand_total BIGINT)
LANGUAGE sql STABLE AS $function$
  WITH eb AS (
    SELECT
      CASE WHEN p_group = 'campaign' THEN c.name
           ELSE COALESCE(cl.name, 'Unassigned') END AS label,
      'emailbison'::TEXT AS platform,
      SUM(d.emails_sent)::BIGINT AS sent
    FROM campaign_day_stats d
    JOIN campaigns c            ON c.id = d.campaign_id
    JOIN campaign_clients cc    ON cc.campaign_id = d.campaign_id
    LEFT JOIN clients cl        ON cl.id = cc.client_id
    WHERE d.team_id = p_team_id
      AND d.stat_date BETWEEN p_from AND p_to
      AND NOT cc.excluded
      AND c.deleted_at IS NULL
      AND (p_client_ids IS NULL OR cc.client_id = ANY(p_client_ids))
    GROUP BY 1
  ),
  inst AS (
    SELECT
      CASE WHEN p_group = 'campaign' THEN ic.name
           ELSE COALESCE(cl.name, 'Unassigned') END AS label,
      'instantly'::TEXT AS platform,
      SUM(d.sent)::BIGINT AS sent
    FROM instantly_campaign_day_stats d
    JOIN instantly_campaigns ic                ON ic.id = d.campaign_id
    LEFT JOIN instantly_campaign_clients icc   ON icc.campaign_id = d.campaign_id
    LEFT JOIN clients cl                       ON cl.id = icc.client_id
    WHERE d.team_id = p_team_id
      AND d.stat_date BETWEEN p_from AND p_to
      AND COALESCE(icc.excluded, FALSE) = FALSE
      AND ic.archived_at IS NULL
      AND (p_client_ids IS NULL OR icc.client_id = ANY(p_client_ids))
    GROUP BY 1
  ),
  combined AS (SELECT * FROM eb UNION ALL SELECT * FROM inst)
  SELECT
    x.label,
    x.platform,
    x.sent,
    -- The whole total rides on every row, so the bar can compute a share
    -- without a second query and without the client summing a truncated list.
    SUM(x.sent) OVER () AS grand_total
  FROM combined x
  WHERE x.sent > 0
  ORDER BY x.sent DESC
  LIMIT p_limit;
$function$;

INSERT INTO schema_migrations (version) VALUES ('076_volume_split')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
