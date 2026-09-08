-- 066 — the Leads tab hides removed leads, and can show only them.
--
-- GENERATED FROM THE LIVE DEFINITION with two substitutions, the way 048 and
-- 063 were built. This function carries the search, the status filter, the
-- LATERAL that replaced 7,302 index probes with one pass, the sort and the
-- paging; retyping it to add a WHERE clause is how one of those quietly breaks.
--
-- 'removed' is a value in the SAME status filter as bounced/replied/completed,
-- not a separate parameter, so the existing facet chips drive it with no new
-- plumbing. It is not a derived_status though -- a removed lead also bounced or
-- replied or completed, and overwriting that would lose the reason it was
-- removed -- so the second substitution stops it being matched against
-- derived_status, which can never equal 'removed'.

BEGIN;

CREATE OR REPLACE FUNCTION public.analytics_campaign_lead_rows(p_team_id bigint, p_campaign_id bigint, p_search text DEFAULT NULL::text, p_status text[] DEFAULT NULL::text[], p_sort text DEFAULT NULL::text, p_dir text DEFAULT 'desc'::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(lead_id bigint, email text, first_name text, last_name text, company text, title text, lead_status text, status text, step_reached integer, sends integer, first_sent_at timestamp with time zone, last_sent_at timestamp with time zone, opens integer, unique_opens integer, clicks integer, replies bigint, positive bigint, bounces bigint, sender_email text, attributes jsonb, total_count bigint)
 LANGUAGE sql
 STABLE
AS $function$
  WITH step_count AS (
    -- Once, not once per row.
    SELECT COUNT(*)::INTEGER AS steps FROM sequence_steps ss
     WHERE ss.campaign_id = p_campaign_id AND NOT ss.is_variant
  ),
  scoped AS (
    /*
     * Ids and sort keys only. Every join that costs anything — the reply probe,
     * the attribute rollup, the sender lookup — happens after the page is cut.
     */
    SELECT
      cl.lead_id,
      cl.step_reached, cl.sends, cl.first_sent_at, cl.last_sent_at,
      cl.opens, cl.unique_opens, cl.clicks,
      l.email, l.first_name, l.last_name, l.company, l.title,
      CASE
        WHEN rp.bounced  THEN 'bounced'
        WHEN rp.positive THEN 'positive'
        WHEN rp.replied  THEN 'replied'
        WHEN cl.step_reached >= sc.steps THEN 'completed'
        ELSE 'contacted'
      END AS derived_status,
      rp.replies, rp.positives, rp.bounces
    FROM campaign_leads cl
    LEFT JOIN leads l ON l.id = cl.lead_id
    CROSS JOIN step_count sc
    /*
     * ONE index scan per lead, not three.
     *
     * This was three correlated EXISTS — bounced, positive, replied — each
     * probing `replies` for every lead in the campaign before the page was cut:
     * 7,302 probes to render 50 rows on a 2,434-lead campaign. Same shape as the
     * bug 029 fixed. One LATERAL aggregates all of it in a single pass, and it
     * returns the counts too, so the outer query no longer needs its own three
     * subqueries either.
     */
    LEFT JOIN LATERAL (
      SELECT
        bool_or(r.is_bounce_notification)                                  AS bounced,
        bool_or(r.tracked_reply AND NOT r.is_bounce_notification)          AS replied,
        bool_or(r.tracked_reply AND NOT r.is_bounce_notification
                AND r.sentiment = 'positive')                              AS positive,
        COUNT(*) FILTER (WHERE r.tracked_reply AND NOT r.is_bounce_notification) AS replies,
        COUNT(*) FILTER (WHERE r.tracked_reply AND NOT r.is_bounce_notification
                           AND r.sentiment = 'positive')                   AS positives,
        COUNT(*) FILTER (WHERE r.is_bounce_notification)                   AS bounces
      FROM replies r
      WHERE r.campaign_id = cl.campaign_id AND r.lead_id = cl.lead_id
    ) rp ON TRUE
    WHERE cl.team_id = p_team_id
      AND cl.campaign_id = p_campaign_id
      /*
       * Removed leads are hidden by default and reachable only by asking for
       * them, which is why this reads the status array rather than a separate
       * flag: 'removed' is a choice in the same control as every other filter.
       */
      AND (
        CASE WHEN 'removed' = ANY(COALESCE(p_status, ARRAY[]::TEXT[]))
             THEN cl.removed_at IS NOT NULL
             ELSE cl.removed_at IS NULL END
      )
      AND (
        p_search IS NULL
        OR l.email      ILIKE '%' || p_search || '%'
        OR l.first_name ILIKE '%' || p_search || '%'
        OR l.last_name  ILIKE '%' || p_search || '%'
        OR l.company    ILIKE '%' || p_search || '%'
      )
  ),
  filtered AS (
    SELECT * FROM scoped
     WHERE p_status IS NULL
        OR p_status = ARRAY['removed']::TEXT[]
        OR derived_status = ANY(p_status)
  ),
  page AS (
    SELECT f.*, COUNT(*) OVER () AS total
    FROM filtered f
    /*
     * Four clauses — numeric asc/desc, text asc/desc — then the default. Same
     * shape as 052. p_sort NULL is the third click: everything collapses and
     * the default takes over.
     */
    ORDER BY
      (CASE WHEN p_dir = 'asc' THEN CASE p_sort
        WHEN 'sends' THEN f.sends::NUMERIC
        WHEN 'step_reached' THEN f.step_reached::NUMERIC
        WHEN 'opens' THEN f.opens::NUMERIC
        WHEN 'unique_opens' THEN f.unique_opens::NUMERIC
        WHEN 'clicks' THEN f.clicks::NUMERIC
        WHEN 'first_sent_at' THEN EXTRACT(EPOCH FROM f.first_sent_at)
        WHEN 'last_sent_at' THEN EXTRACT(EPOCH FROM f.last_sent_at)
      END END) ASC NULLS LAST,
      (CASE WHEN p_dir <> 'asc' THEN CASE p_sort
        WHEN 'sends' THEN f.sends::NUMERIC
        WHEN 'step_reached' THEN f.step_reached::NUMERIC
        WHEN 'opens' THEN f.opens::NUMERIC
        WHEN 'unique_opens' THEN f.unique_opens::NUMERIC
        WHEN 'clicks' THEN f.clicks::NUMERIC
        WHEN 'first_sent_at' THEN EXTRACT(EPOCH FROM f.first_sent_at)
        WHEN 'last_sent_at' THEN EXTRACT(EPOCH FROM f.last_sent_at)
      END END) DESC NULLS LAST,
      (CASE WHEN p_dir = 'asc' THEN CASE p_sort
        WHEN 'email' THEN NULLIF(f.email, '')
        WHEN 'first_name' THEN NULLIF(f.first_name, '')
        WHEN 'company' THEN NULLIF(f.company, '')
        WHEN 'title' THEN NULLIF(f.title, '')
        WHEN 'status' THEN f.derived_status
      END END) ASC NULLS LAST,
      (CASE WHEN p_dir <> 'asc' THEN CASE p_sort
        WHEN 'email' THEN NULLIF(f.email, '')
        WHEN 'first_name' THEN NULLIF(f.first_name, '')
        WHEN 'company' THEN NULLIF(f.company, '')
        WHEN 'title' THEN NULLIF(f.title, '')
        WHEN 'status' THEN f.derived_status
      END END) DESC NULLS LAST,
      f.last_sent_at DESC NULLS LAST, f.lead_id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT
    p.lead_id, p.email, p.first_name, p.last_name, p.company, p.title,
    l.status,
    p.derived_status,
    p.step_reached, p.sends, p.first_sent_at, p.last_sent_at,
    p.opens, p.unique_opens, p.clicks,
    p.replies, p.positives, p.bounces,
    se.email,
    /*
     * Every custom variable as one JSONB blob rather than N named columns.
     * That is the point of 027's long-not-wide shape: a new variable upstream
     * becomes a row and a column-registry entry, with NO migration.
     */
    COALESCE(
      (SELECT jsonb_object_agg(la.name, la.value)
         FROM lead_attributes la
        WHERE la.lead_id = p.lead_id AND la.value IS NOT NULL),
      '{}'::jsonb
    ),
    p.total
  FROM page p
  LEFT JOIN leads l         ON l.id = p.lead_id
  LEFT JOIN campaign_leads c ON c.campaign_id = p_campaign_id AND c.lead_id = p.lead_id
  LEFT JOIN sender_emails se ON se.id = c.sender_email_id
  ORDER BY p.total DESC, p.last_sent_at DESC NULLS LAST, p.lead_id;
$function$;

INSERT INTO schema_migrations (version) VALUES ('066_lead_rows_removed')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
