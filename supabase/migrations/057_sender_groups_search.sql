-- 057 — search and full sorting on the domain and provider views.
--
-- TWO GAPS, both only reachable from those two views.
--
-- 1. NO SEARCH. The Infrastructure search box was rendered only for the inbox
--    view, and this function had no search parameter to take one anyway. With
--    503 domains, finding a named one meant scrolling.
--
-- 2. THE NAME COLUMN COULD NOT BE SORTED. 052 gave every other column a sort
--    but dropped the label, because this query aggregates with GROUP BY 1 and
--    Postgres will not order an aggregate query by an ungrouped column —
--    "column s.provider must appear in the GROUP BY clause". Dropping it was
--    the expedient fix; wrapping the aggregate is the correct one. The ORDER BY
--    now sits OUTSIDE the grouping, over its finished output, where the label is
--    an ordinary column.
--
-- The search deliberately runs INSIDE the aggregate, on the underlying inbox
-- rows, so a filtered domain's totals are the totals of that domain rather than
-- of the whole estate. Filtering after grouping would give the same rows but
-- the wrong numbers on any partial match.

BEGIN;

DROP FUNCTION IF EXISTS analytics_sender_groups(BIGINT, TEXT, INTEGER, TEXT, TEXT);

CREATE FUNCTION analytics_sender_groups(
  p_team_id   BIGINT,
  p_group     TEXT    DEFAULT 'domain',
  p_min_sent  INTEGER DEFAULT 0,
  p_sort      TEXT    DEFAULT NULL,
  p_dir       TEXT    DEFAULT 'desc',
  p_search    TEXT    DEFAULT NULL
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
LANGUAGE sql STABLE AS $$
  WITH grouped AS (
    SELECT
      COALESCE(
        CASE WHEN p_group = 'provider' THEN s.provider ELSE s.domain END,
        'unknown'
      ) AS label,
      COUNT(*)                                  AS inboxes,
      SUM(COALESCE(s.lifetime_sent, 0))         AS sent,
      SUM(COALESCE(s.lifetime_bounced, 0))      AS bounced,
      SUM(COALESCE(s.unique_replied, 0))        AS replied
    FROM sender_emails s
    WHERE s.team_id = p_team_id
      AND COALESCE(s.lifetime_sent, 0) >= p_min_sent
      /*
       * Matched on the inbox row, before grouping. Searching the domain OR the
       * mailbox address is what people actually do — "who is sending from
       * nicole@?" is as common as "how is this domain doing?" — and on the
       * provider view the domain is still the useful thing to search by.
       */
      AND (
        p_search IS NULL
        OR s.domain   ILIKE '%' || p_search || '%'
        OR s.email    ILIKE '%' || p_search || '%'
        OR s.provider ILIKE '%' || p_search || '%'
      )
    GROUP BY 1
  )
  SELECT
    g.label, g.inboxes, g.sent, g.bounced, g.replied,
    CASE WHEN g.sent > 0 THEN g.bounced::NUMERIC / g.sent END,
    CASE WHEN g.sent > 0 THEN g.replied::NUMERIC / g.sent END
  FROM grouped g
  /*
   * Outside the aggregate, so `label` is orderable like anything else. Same
   * four-clause shape as 052 — numeric asc, numeric desc, text asc, text desc —
   * then the view's own default. A NULL p_sort collapses every clause and the
   * default takes over, which is the third click.
   */
  ORDER BY
    (CASE WHEN p_dir = 'asc' THEN CASE p_sort
      WHEN 'sent'        THEN g.sent::NUMERIC
      WHEN 'inboxes'     THEN g.inboxes::NUMERIC
      WHEN 'bounced'     THEN g.bounced::NUMERIC
      WHEN 'bounce_rate' THEN CASE WHEN g.sent > 0 THEN g.bounced::NUMERIC / g.sent END
      WHEN 'reply_rate'  THEN CASE WHEN g.sent > 0 THEN g.replied::NUMERIC / g.sent END
    END END) ASC NULLS LAST,
    (CASE WHEN p_dir <> 'asc' THEN CASE p_sort
      WHEN 'sent'        THEN g.sent::NUMERIC
      WHEN 'inboxes'     THEN g.inboxes::NUMERIC
      WHEN 'bounced'     THEN g.bounced::NUMERIC
      WHEN 'bounce_rate' THEN CASE WHEN g.sent > 0 THEN g.bounced::NUMERIC / g.sent END
      WHEN 'reply_rate'  THEN CASE WHEN g.sent > 0 THEN g.replied::NUMERIC / g.sent END
    END END) DESC NULLS LAST,
    (CASE WHEN p_dir = 'asc'  THEN CASE p_sort WHEN 'label' THEN NULLIF(g.label, '') END END) ASC NULLS LAST,
    (CASE WHEN p_dir <> 'asc' THEN CASE p_sort WHEN 'label' THEN NULLIF(g.label, '') END END) DESC NULLS LAST,
    g.sent DESC;
$$;

INSERT INTO schema_migrations (version) VALUES ('057_sender_groups_search')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
