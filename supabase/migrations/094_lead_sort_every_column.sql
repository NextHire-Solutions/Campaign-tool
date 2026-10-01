-- 094 — Sort a campaign's leads by any column (2 Oct).
--
-- The Leads tab sorted by ten columns; the rest (Lead, Domain, Sent from,
-- Replies, Positive, Bounces and every lead attribute) had no sort, and
-- Instantly campaigns had none at all. Asked for: "sorting in all the
-- columns … even for the hidden fields that we can show".
--
-- Additive: every existing p_sort value sorts exactly as before, and a call
-- that passes no p_sort gets the same default order. Safe to re-run.
--
--   name          the lead's name, else its email
--   domain        the part of the email after @
--   sender_email  the mailbox that sent to the lead
--   replies / positive / bounces
--   attr:<name>   a lead attribute as text   (phone, MLS, cities, Courted)
--   attrn:<name>  a lead attribute as a number — "$2,300,000" sorts as
--                 2300000, not as text; a value with no digits sorts last.
--
-- Attributes are read only for the attribute being sorted on, one indexed
-- lookup per lead (lead_attributes_pkey is (lead_id, name)).

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
      cl.opens, cl.unique_opens, cl.clicks, cl.sender_email_id,
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

/*
 * Instantly campaigns: the same, from instantly_leads. It had no sort at all.
 * Two new parameters means a new signature, so the old function is dropped
 * and recreated; both have defaults, so the standalone app's call (which
 * passes neither) keeps working and keeps its order. Same grants as before.
 */
DROP FUNCTION IF EXISTS public.analytics_instantly_lead_rows(bigint, uuid, text, text[], integer, integer);

CREATE OR REPLACE FUNCTION public.analytics_instantly_lead_rows(p_team_id bigint, p_campaign_id uuid, p_search text DEFAULT NULL::text, p_status text[] DEFAULT NULL::text[], p_limit integer DEFAULT 100, p_offset integer DEFAULT 0, p_sort text DEFAULT NULL::text, p_dir text DEFAULT 'desc'::text)
 RETURNS TABLE(lead_id uuid, email text, first_name text, last_name text, company text, status text, raw_status integer, replies integer, opens integer, last_sent_at timestamp with time zone, total_count bigint)
 LANGUAGE sql
 STABLE
AS $function$
  WITH derived AS (
    SELECT
      l.id, l.email, l.first_name, l.last_name, l.company_name,
      l.status AS raw_status, l.email_reply_count, l.email_open_count,
      l.last_contact_at,
      CASE
        WHEN l.email_reply_count > 0    THEN 'replied'
        WHEN l.last_contact_at IS NOT NULL THEN 'contacted'
        ELSE 'not contacted'
      END AS derived_status
    FROM instantly_leads l
    WHERE l.team_id = p_team_id
      AND l.campaign_id = p_campaign_id
      AND (
        p_search IS NULL OR p_search = '' OR
        l.email ILIKE '%' || p_search || '%' OR
        COALESCE(l.first_name,'') || ' ' || COALESCE(l.last_name,'') ILIKE '%' || p_search || '%' OR
        COALESCE(l.company_name,'') ILIKE '%' || p_search || '%'
      )
  ),
  filtered AS (
    SELECT * FROM derived
    WHERE p_status IS NULL OR derived_status = ANY(p_status)
  )
  SELECT
    f.id, f.email, f.first_name, f.last_name, f.company_name,
    f.derived_status, f.raw_status, f.email_reply_count, f.email_open_count,
    f.last_contact_at,
    -- Rides on every row so paging needs no second count query.
    COUNT(*) OVER () AS total_count
  FROM filtered f
  ORDER BY
    (CASE WHEN p_dir = 'asc' THEN CASE p_sort
      WHEN 'replies' THEN f.email_reply_count::NUMERIC
      WHEN 'opens' THEN f.email_open_count::NUMERIC
      WHEN 'last_sent_at' THEN EXTRACT(EPOCH FROM f.last_contact_at)
    END END) ASC NULLS LAST,
    (CASE WHEN p_dir <> 'asc' THEN CASE p_sort
      WHEN 'replies' THEN f.email_reply_count::NUMERIC
      WHEN 'opens' THEN f.email_open_count::NUMERIC
      WHEN 'last_sent_at' THEN EXTRACT(EPOCH FROM f.last_contact_at)
    END END) DESC NULLS LAST,
    (CASE WHEN p_dir = 'asc' THEN CASE p_sort
      WHEN 'name' THEN lower(COALESCE(NULLIF(btrim(COALESCE(f.first_name, '') || ' ' || COALESCE(f.last_name, '')), ''), f.email))
      WHEN 'email' THEN lower(NULLIF(f.email, ''))
      WHEN 'domain' THEN NULLIF(lower(split_part(f.email, '@', 2)), '')
      WHEN 'company' THEN lower(NULLIF(f.company_name, ''))
      WHEN 'status' THEN f.derived_status
    END END) ASC NULLS LAST,
    (CASE WHEN p_dir <> 'asc' THEN CASE p_sort
      WHEN 'name' THEN lower(COALESCE(NULLIF(btrim(COALESCE(f.first_name, '') || ' ' || COALESCE(f.last_name, '')), ''), f.email))
      WHEN 'email' THEN lower(NULLIF(f.email, ''))
      WHEN 'domain' THEN NULLIF(lower(split_part(f.email, '@', 2)), '')
      WHEN 'company' THEN lower(NULLIF(f.company_name, ''))
      WHEN 'status' THEN f.derived_status
    END END) DESC NULLS LAST,
    f.last_contact_at DESC NULLS LAST, f.email
  LIMIT p_limit OFFSET p_offset;
$function$;

GRANT EXECUTE ON FUNCTION public.analytics_instantly_lead_rows(bigint, uuid, text, text[], integer, integer, text, text) TO PUBLIC, anon, authenticated, service_role;

COMMIT;
