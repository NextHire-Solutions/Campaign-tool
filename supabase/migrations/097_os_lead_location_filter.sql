-- 097 — a campaign's leads: search by office city, and a location filter
-- (BrokerStaffer OS, 13 Oct).
--
-- Campaign Management → Campaigns → a campaign → Leads.
--
--   1. SEARCH (Amy): the search box also matches the lead's OFFICE CITY, so
--      "woodland hills" finds the leads whose office is there. It matched
--      name, email and company only, and answered "No leads match that".
--   2. LOCATION FILTER (Eddy): office city, home city, most transacted city.
--      One new argument, p_loc — { "<attribute name>": ["City, ST", …], … }.
--      Cities within a field are alternatives; fields combine (a lead must
--      match every field that has cities chosen). Any case, exact city.
--      The attribute names the OS sends: 'office city', 'home city' and
--      'top producing city' (= most transacted city).
--   3. THE CITIES TO CHOOSE FROM: analytics_os_campaign_lead_locations returns
--      each field's cities in one campaign with how many leads each has, as
--      ONE json value — a row per city would be cut at 1,000 by the API.
--
-- ONLY 095/096's OS-ONLY FUNCTIONS CHANGE. As in 096 the old signatures are
-- dropped and the new ones created in one transaction — never overloaded,
-- because two versions with defaulted arguments make the API's calls
-- ambiguous. p_loc defaults to "no filter", so the OS keeps working unchanged
-- the moment this runs; the one visible change before the OS is updated is
-- that its search starts matching office city. The standalone Analytics app
-- never calls these functions. EmailBison campaigns only — Instantly leads
-- carry no attributes. Safe to re-run.

BEGIN;

DROP FUNCTION IF EXISTS public.analytics_os_campaign_lead_rows(bigint, bigint, text, text[], text, text, integer, integer, bigint[], text[], text, numeric, numeric);
DROP FUNCTION IF EXISTS public.analytics_os_campaign_lead_ids(bigint, bigint, text, text[], bigint[], text[], text, numeric, numeric);

CREATE OR REPLACE FUNCTION public.analytics_os_campaign_lead_rows(p_team_id bigint, p_campaign_id bigint, p_search text DEFAULT NULL::text, p_status text[] DEFAULT NULL::text[], p_sort text DEFAULT NULL::text, p_dir text DEFAULT 'desc'::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_intro_lead_ids bigint[] DEFAULT NULL::bigint[], p_intro_emails text[] DEFAULT NULL::text[], p_attr text DEFAULT NULL::text, p_attr_min numeric DEFAULT NULL::numeric, p_attr_max numeric DEFAULT NULL::numeric, p_loc jsonb DEFAULT NULL::jsonb)
 RETURNS TABLE(lead_id bigint, email text, first_name text, last_name text, company text, title text, lead_status text, status text, step_reached integer, sends integer, first_sent_at timestamp with time zone, last_sent_at timestamp with time zone, opens integer, unique_opens integer, clicks integer, replies bigint, positive bigint, bounces bigint, sender_email text, attributes jsonb, total_count bigint)
 LANGUAGE sql
 STABLE
AS $function$
  WITH step_count AS (
    -- Once, not once per row.
    SELECT COUNT(*)::INTEGER AS steps FROM sequence_steps ss
     WHERE ss.campaign_id = p_campaign_id AND NOT ss.is_variant
  ),
  loc AS (
    /*
     * The location filter (097), read once: one row per field that has cities
     * chosen, with the cities lower-cased. p_loc is
     *   { "office city": ["Woodland Hills, CA", …], "top producing city": […] }
     * — the keys are lead-attribute names. Anything else (not an object, a
     * field that is not a list, blanks) reads as "no cities" — the CASEs are
     * there so a malformed value is ignored rather than raising — and a field
     * with no cities is skipped by the filter below.
     */
    SELECT f.key AS name,
           ARRAY(SELECT lower(btrim(v))
                   FROM jsonb_array_elements_text(
                          CASE WHEN jsonb_typeof(f.value) = 'array' THEN f.value ELSE '[]'::jsonb END) v
                  WHERE btrim(v) <> '') AS cities
      FROM jsonb_each(CASE WHEN jsonb_typeof(p_loc) = 'object' THEN p_loc ELSE '{}'::jsonb END) f
  ),
  scoped AS (
    /*
     * Ids and sort keys only. Every join that costs anything — the reply probe,
     * the attribute rollup, the sender lookup — happens after the page is cut.
     */
    SELECT
      cl.lead_id,
      cl.step_reached, cl.sends, cl.first_sent_at, cl.last_sent_at,
      cl.opens, cl.unique_opens, cl.clicks, cl.sender_email_id,
      l.email, l.first_name, l.last_name, l.company, l.title,
      CASE
        WHEN cl.lead_id = ANY(COALESCE(p_intro_lead_ids, ARRAY[]::BIGINT[]))
          OR lower(l.email) = ANY(COALESCE(p_intro_emails, ARRAY[]::TEXT[])) THEN 'introduced'
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
        /*
         * Office city too (097 — Amy, 13 Oct): typing "woodland hills" finds
         * the leads whose office is there.
         */
        OR EXISTS (
          SELECT 1 FROM lead_attributes la
           WHERE la.lead_id = cl.lead_id AND la.name = 'office city'
             AND la.value ILIKE '%' || p_search || '%'
        )
      )
      /*
       * Amount filter on one lead attribute (096): "Sales volume from / to".
       * Off unless p_attr and a bound are given. A lead without a readable
       * amount is left out while the filter is on.
       */
      AND (
        p_attr IS NULL OR (p_attr_min IS NULL AND p_attr_max IS NULL)
        OR EXISTS (
          SELECT 1 FROM lead_attributes la
           WHERE la.lead_id = cl.lead_id AND la.name = p_attr
             AND public.analytics_os_amount(la.value) IS NOT NULL
             AND (p_attr_min IS NULL OR public.analytics_os_amount(la.value) >= p_attr_min)
             AND (p_attr_max IS NULL OR public.analytics_os_amount(la.value) <= p_attr_max)
        )
      )
      /*
       * Location filter (097 — Eddy, 13 Oct): office city, home city, most
       * transacted city. A lead passes when, for EVERY field that has cities
       * chosen, its own value is one of them (any case). A lead with nothing
       * on file for a chosen field is left out while the filter is on.
       */
      AND NOT EXISTS (
        SELECT 1 FROM loc f
         WHERE f.cities <> ARRAY[]::TEXT[]
           AND NOT EXISTS (
             SELECT 1 FROM lead_attributes la
              WHERE la.lead_id = cl.lead_id AND la.name = f.name
                AND lower(btrim(la.value)) = ANY(f.cities)
           )
      )
  ),
  filtered AS (
    SELECT * FROM scoped
     WHERE p_status IS NULL
        OR p_status = ARRAY['removed']::TEXT[]
        OR derived_status = ANY(p_status)
  ),
  keyed AS (
    /*
     * The two sort keys that need a lookup, computed only when asked for —
     * every other p_sort leaves both NULL and costs nothing.
     */
    SELECT f.*,
      CASE
        WHEN p_sort LIKE 'attr:%' OR p_sort LIKE 'attrn:%' THEN
          (SELECT NULLIF(btrim(la.value), '') FROM lead_attributes la
            WHERE la.lead_id = f.lead_id AND la.name = split_part(p_sort, ':', 2))
        WHEN p_sort = 'sender_email' THEN
          (SELECT se.email FROM sender_emails se WHERE se.id = f.sender_email_id)
      END AS sort_text
    FROM filtered f
  ),
  ranked AS (
    /*
     * Each row's place in the chosen order, as a number. The page is cut by it
     * and the final SELECT orders by it — before this, the final SELECT
     * re-sorted the page by last_sent_at, so a page sorted by anything else
     * came back in the right 50 rows but the wrong order (2 Oct).
     *
     * Four clauses — numeric asc/desc, text asc/desc — then the default. Same
     * shape as 052. p_sort NULL is the third click: everything collapses and
     * the default takes over.
     */
    SELECT k.*, COUNT(*) OVER () AS total, ROW_NUMBER() OVER (ORDER BY
      (CASE WHEN p_dir = 'asc' THEN CASE
        WHEN p_sort = 'sends' THEN k.sends::NUMERIC
        WHEN p_sort = 'step_reached' THEN k.step_reached::NUMERIC
        WHEN p_sort = 'opens' THEN k.opens::NUMERIC
        WHEN p_sort = 'unique_opens' THEN k.unique_opens::NUMERIC
        WHEN p_sort = 'clicks' THEN k.clicks::NUMERIC
        WHEN p_sort = 'first_sent_at' THEN EXTRACT(EPOCH FROM k.first_sent_at)
        WHEN p_sort = 'last_sent_at' THEN EXTRACT(EPOCH FROM k.last_sent_at)
        WHEN p_sort = 'replies' THEN k.replies::NUMERIC
        WHEN p_sort = 'positive' THEN k.positives::NUMERIC
        WHEN p_sort = 'bounces' THEN k.bounces::NUMERIC
        WHEN p_sort LIKE 'attrn:%' AND k.sort_text ~ '[0-9]' AND k.sort_text !~ '[0-9.,]\s+[0-9]'
          THEN NULLIF(regexp_replace(k.sort_text, '[^0-9.]', '', 'g'), '')::NUMERIC
      END END) ASC NULLS LAST,
      (CASE WHEN p_dir <> 'asc' THEN CASE
        WHEN p_sort = 'sends' THEN k.sends::NUMERIC
        WHEN p_sort = 'step_reached' THEN k.step_reached::NUMERIC
        WHEN p_sort = 'opens' THEN k.opens::NUMERIC
        WHEN p_sort = 'unique_opens' THEN k.unique_opens::NUMERIC
        WHEN p_sort = 'clicks' THEN k.clicks::NUMERIC
        WHEN p_sort = 'first_sent_at' THEN EXTRACT(EPOCH FROM k.first_sent_at)
        WHEN p_sort = 'last_sent_at' THEN EXTRACT(EPOCH FROM k.last_sent_at)
        WHEN p_sort = 'replies' THEN k.replies::NUMERIC
        WHEN p_sort = 'positive' THEN k.positives::NUMERIC
        WHEN p_sort = 'bounces' THEN k.bounces::NUMERIC
        WHEN p_sort LIKE 'attrn:%' AND k.sort_text ~ '[0-9]' AND k.sort_text !~ '[0-9.,]\s+[0-9]'
          THEN NULLIF(regexp_replace(k.sort_text, '[^0-9.]', '', 'g'), '')::NUMERIC
      END END) DESC NULLS LAST,
      (CASE WHEN p_dir = 'asc' THEN CASE
        WHEN p_sort = 'email' THEN NULLIF(k.email, '')
        WHEN p_sort = 'first_name' THEN NULLIF(k.first_name, '')
        WHEN p_sort = 'name' THEN lower(COALESCE(NULLIF(btrim(COALESCE(k.first_name, '') || ' ' || COALESCE(k.last_name, '')), ''), k.email))
        WHEN p_sort = 'domain' THEN NULLIF(lower(split_part(k.email, '@', 2)), '')
        WHEN p_sort = 'company' THEN NULLIF(k.company, '')
        WHEN p_sort = 'title' THEN NULLIF(k.title, '')
        WHEN p_sort = 'status' THEN k.derived_status
        WHEN p_sort = 'sender_email' OR p_sort LIKE 'attr:%' THEN lower(k.sort_text)
      END END) ASC NULLS LAST,
      (CASE WHEN p_dir <> 'asc' THEN CASE
        WHEN p_sort = 'email' THEN NULLIF(k.email, '')
        WHEN p_sort = 'first_name' THEN NULLIF(k.first_name, '')
        WHEN p_sort = 'name' THEN lower(COALESCE(NULLIF(btrim(COALESCE(k.first_name, '') || ' ' || COALESCE(k.last_name, '')), ''), k.email))
        WHEN p_sort = 'domain' THEN NULLIF(lower(split_part(k.email, '@', 2)), '')
        WHEN p_sort = 'company' THEN NULLIF(k.company, '')
        WHEN p_sort = 'title' THEN NULLIF(k.title, '')
        WHEN p_sort = 'status' THEN k.derived_status
        WHEN p_sort = 'sender_email' OR p_sort LIKE 'attr:%' THEN lower(k.sort_text)
      END END) DESC NULLS LAST,
      k.last_sent_at DESC NULLS LAST, k.lead_id
    ) AS rn
    FROM keyed k
  ),
  page AS (
    SELECT * FROM ranked WHERE rn > p_offset AND rn <= p_offset + p_limit
  )
  SELECT
    p.lead_id, p.email, p.first_name, p.last_name, p.company, p.title,
    l.status,
    p.derived_status,
    p.step_reached, p.sends, p.first_sent_at, p.last_sent_at,
    p.opens, p.unique_opens, p.clicks,
    p.replies, p.positives, p.bounces,
    se.email,
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
  /*
   * The page's own order, carried out of the CTE. This used to re-sort by
   * last_sent_at, which only kept the page in order because the default sort
   * was last_sent_at; with every column sortable it has to be the real order.
   */
  ORDER BY p.rn;
$function$;

CREATE OR REPLACE FUNCTION public.analytics_os_campaign_lead_ids(
  p_team_id     BIGINT,
  p_campaign_id BIGINT,
  p_search      TEXT     DEFAULT NULL,
  p_status      TEXT[]   DEFAULT NULL,
  p_intro_lead_ids BIGINT[] DEFAULT NULL,
  p_intro_emails   TEXT[]   DEFAULT NULL,
  p_attr           TEXT     DEFAULT NULL,
  p_attr_min       NUMERIC  DEFAULT NULL,
  p_attr_max       NUMERIC  DEFAULT NULL,
  p_loc            JSONB    DEFAULT NULL
)
RETURNS BIGINT[]
LANGUAGE sql STABLE AS $function$
  SELECT COALESCE(ARRAY_AGG(x.lead_id), ARRAY[]::BIGINT[]) FROM (
  WITH step_count AS (
    -- Once, not once per row.
    SELECT COUNT(*)::INTEGER AS steps FROM sequence_steps ss
     WHERE ss.campaign_id = p_campaign_id AND NOT ss.is_variant
  ),
  loc AS (
    /*
     * The location filter (097), read once: one row per field that has cities
     * chosen, with the cities lower-cased. p_loc is
     *   { "office city": ["Woodland Hills, CA", …], "top producing city": […] }
     * — the keys are lead-attribute names. Anything else (not an object, a
     * field that is not a list, blanks) reads as "no cities" — the CASEs are
     * there so a malformed value is ignored rather than raising — and a field
     * with no cities is skipped by the filter below.
     */
    SELECT f.key AS name,
           ARRAY(SELECT lower(btrim(v))
                   FROM jsonb_array_elements_text(
                          CASE WHEN jsonb_typeof(f.value) = 'array' THEN f.value ELSE '[]'::jsonb END) v
                  WHERE btrim(v) <> '') AS cities
      FROM jsonb_each(CASE WHEN jsonb_typeof(p_loc) = 'object' THEN p_loc ELSE '{}'::jsonb END) f
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
        WHEN cl.lead_id = ANY(COALESCE(p_intro_lead_ids, ARRAY[]::BIGINT[]))
          OR lower(l.email) = ANY(COALESCE(p_intro_emails, ARRAY[]::TEXT[])) THEN 'introduced'
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
        /*
         * Office city too (097 — Amy, 13 Oct): typing "woodland hills" finds
         * the leads whose office is there.
         */
        OR EXISTS (
          SELECT 1 FROM lead_attributes la
           WHERE la.lead_id = cl.lead_id AND la.name = 'office city'
             AND la.value ILIKE '%' || p_search || '%'
        )
      )
      /*
       * Amount filter on one lead attribute (096): "Sales volume from / to".
       * Off unless p_attr and a bound are given. A lead without a readable
       * amount is left out while the filter is on.
       */
      AND (
        p_attr IS NULL OR (p_attr_min IS NULL AND p_attr_max IS NULL)
        OR EXISTS (
          SELECT 1 FROM lead_attributes la
           WHERE la.lead_id = cl.lead_id AND la.name = p_attr
             AND public.analytics_os_amount(la.value) IS NOT NULL
             AND (p_attr_min IS NULL OR public.analytics_os_amount(la.value) >= p_attr_min)
             AND (p_attr_max IS NULL OR public.analytics_os_amount(la.value) <= p_attr_max)
        )
      )
      /*
       * Location filter (097 — Eddy, 13 Oct): office city, home city, most
       * transacted city. A lead passes when, for EVERY field that has cities
       * chosen, its own value is one of them (any case). A lead with nothing
       * on file for a chosen field is left out while the filter is on.
       */
      AND NOT EXISTS (
        SELECT 1 FROM loc f
         WHERE f.cities <> ARRAY[]::TEXT[]
           AND NOT EXISTS (
             SELECT 1 FROM lead_attributes la
              WHERE la.lead_id = cl.lead_id AND la.name = f.name
                AND lower(btrim(la.value)) = ANY(f.cities)
           )
      )
  ),
  filtered AS (
    SELECT * FROM scoped
     WHERE p_status IS NULL
        OR p_status = ARRAY['removed']::TEXT[]
        OR derived_status = ANY(p_status)
  )
  SELECT f.lead_id FROM filtered f
  ) x;
$function$;

CREATE OR REPLACE FUNCTION public.analytics_os_campaign_lead_locations(
  p_team_id     BIGINT,
  p_campaign_id BIGINT,
  p_names       TEXT[]
)
RETURNS JSONB
LANGUAGE sql STABLE AS $function$
  /*
   * { "<attribute name>": [ { "value": "Woodland Hills, CA", "leads": 132 }, … ], … }
   * — every name asked for is a key, with [] when no lead carries it. Most
   * leads first. One spelling per city whatever its case; leads removed from
   * the campaign are not counted, as on the Leads tab itself.
   */
  SELECT COALESCE(jsonb_object_agg(n.name, COALESCE(v.cities, '[]'::jsonb)), '{}'::jsonb)
    FROM (SELECT DISTINCT x AS name FROM unnest(COALESCE(p_names, ARRAY[]::TEXT[])) x WHERE x IS NOT NULL) n
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('value', g.value, 'leads', g.leads) ORDER BY g.leads DESC, g.value) AS cities
        FROM (
          SELECT min(btrim(la.value)) AS value, COUNT(DISTINCT cl.lead_id) AS leads
            FROM campaign_leads cl
            JOIN lead_attributes la ON la.lead_id = cl.lead_id AND la.name = n.name
           WHERE cl.team_id = p_team_id
             AND cl.campaign_id = p_campaign_id
             AND cl.removed_at IS NULL
             AND btrim(COALESCE(la.value, '')) <> ''
           GROUP BY lower(btrim(la.value))
        ) g
    ) v ON TRUE;
$function$;

-- Only the OS's server (service role) calls these.
REVOKE ALL ON FUNCTION public.analytics_os_campaign_lead_rows(bigint, bigint, text, text[], text, text, integer, integer, bigint[], text[], text, numeric, numeric, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_os_campaign_lead_ids(bigint, bigint, text, text[], bigint[], text[], text, numeric, numeric, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_os_campaign_lead_locations(bigint, bigint, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analytics_os_campaign_lead_rows(bigint, bigint, text, text[], text, text, integer, integer, bigint[], text[], text, numeric, numeric, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.analytics_os_campaign_lead_ids(bigint, bigint, text, text[], bigint[], text[], text, numeric, numeric, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.analytics_os_campaign_lead_locations(bigint, bigint, text[]) TO service_role;

COMMIT;

-- Let the API see the new arguments straight away.
NOTIFY pgrst, 'reload schema';
