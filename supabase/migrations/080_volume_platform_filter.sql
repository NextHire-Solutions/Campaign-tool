-- 080 — let the Volume tab answer "how much of this is Bison, and how much is
-- Instantly?"
--
-- 076 put `platform` on every split row and noted that "a stacked or filtered
-- view is possible later without changing the signature". This is that later.
-- The signature does change — there was no way to pass a selection — but the
-- new argument defaults to NULL, so every existing caller keeps its behaviour.
--
-- WHY BOTH FUNCTIONS AND NOT JUST THE SPLIT. Capacity and volume sit in the
-- same tile, one above the other, and are read as a ratio: "35,720/day
-- available against 8,985 actually sent". Filtering only the bottom half of
-- that ratio would show Instantly's 89K of sending against the whole estate's
-- 35,720/day capacity and call it 8% utilisation, when Instantly's own answer
-- is 27%. A ratio whose numerator and denominator describe different
-- populations is worse than no ratio.
--
-- NULL AND THE FULL LIST MEAN THE SAME THING, deliberately. An empty filter bar
-- and both boxes ticked are the same request, and making them return different
-- numbers is the kind of difference nobody would ever think to check.

BEGIN;

/*
 * Postgres treats a new argument as an OVERLOAD, not a replacement — CREATE OR
 * REPLACE would leave BOTH arities live and PostgREST would have to guess which
 * one a request meant. Dropping the old signature first is what makes this a
 * replacement rather than an ambiguity.
 */
DROP FUNCTION IF EXISTS analytics_sending_capacity(BIGINT);
DROP FUNCTION IF EXISTS analytics_volume_split(BIGINT, DATE, DATE, TEXT, UUID[], INTEGER);

/*
 * THE OUTER FILTER IS THE LOAD-BEARING ONE, and the inner guards are only an
 * optimisation. Each branch is an un-grouped aggregate, so it returns exactly
 * one row no matter what its WHERE clause says — an inner guard alone turns
 * "Instantly is not in scope" into a row reading `instantly, 0 inboxes, 0/day`,
 * and the tile renders that as a true claim that Instantly has no capacity.
 * Filtering the union removes the row instead of zeroing it.
 */
CREATE OR REPLACE FUNCTION analytics_sending_capacity(
  p_team_id   BIGINT,
  p_platforms TEXT[] DEFAULT NULL
)
RETURNS TABLE (platform TEXT, inboxes BIGINT, daily_capacity BIGINT, unavailable BIGINT)
LANGUAGE sql STABLE AS $function$
  SELECT * FROM (
    SELECT
      'emailbison'::TEXT AS platform,
      COUNT(*) FILTER (WHERE s.status = 'Connected') AS inboxes,
      COALESCE(SUM(s.daily_limit) FILTER (WHERE s.status = 'Connected'), 0)::BIGINT
        AS daily_capacity,
      COALESCE(SUM(s.daily_limit) FILTER (WHERE s.status IS DISTINCT FROM 'Connected'), 0)::BIGINT
        AS unavailable
    FROM sender_emails s
    WHERE s.team_id = p_team_id AND s.archived_at IS NULL
      AND (p_platforms IS NULL OR 'emailbison' = ANY(p_platforms))

    UNION ALL

    SELECT
      'instantly'::TEXT,
      COUNT(*),
      COALESCE(SUM(a.daily_limit), 0)::BIGINT,
      /*
       * Zero, deliberately. Instantly reports every account as status 2 while
       * the workspace is demonstrably sending, so its status cannot be used to
       * call an inbox unavailable — see docs/instantly-api-findings.md.
       */
      0::BIGINT
    FROM instantly_accounts a
    WHERE a.team_id = p_team_id AND a.archived_at IS NULL
      AND (p_platforms IS NULL OR 'instantly' = ANY(p_platforms))
  ) x
  WHERE p_platforms IS NULL OR x.platform = ANY(p_platforms);
$function$;

/*
 * Volume for the window, split by client or campaign, across the platforms in
 * scope.
 *
 * The filter is applied INSIDE each branch rather than over the union, so an
 * excluded platform costs nothing to scan and — more importantly — so
 * `grand_total` is the total of what is actually on screen. Filtering after the
 * window function would leave every bar computing its share against a total
 * that includes the platform the user just switched off, and every percentage
 * on the tab would silently under-read.
 */
CREATE OR REPLACE FUNCTION analytics_volume_split(
  p_team_id    BIGINT,
  p_from       DATE,
  p_to         DATE,
  p_group      TEXT     DEFAULT 'client',   -- client | campaign
  p_client_ids UUID[]   DEFAULT NULL,
  p_limit      INTEGER  DEFAULT 25,
  p_platforms  TEXT[]   DEFAULT NULL
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
      AND (p_platforms IS NULL OR 'emailbison' = ANY(p_platforms))
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
      AND (p_platforms IS NULL OR 'instantly' = ANY(p_platforms))
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
    SUM(x.sent) OVER () AS grand_total
  FROM combined x
  WHERE x.sent > 0
  ORDER BY x.sent DESC
  LIMIT p_limit;
$function$;

INSERT INTO schema_migrations (version) VALUES ('080_volume_platform_filter')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
