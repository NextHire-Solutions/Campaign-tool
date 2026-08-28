-- 059 — replies broken down by the replier's email provider.
--
-- Another card on the Replies view, beside Brokerage, Location and Sales volume:
-- which mailbox providers the people who reply are actually on.
--
-- WHY A DNS LOOKUP AND NOT JUST THE DOMAIN. Reading the address alone gets you
-- 55.6% Gmail and then stops: 41.6% of replies come from company domains
-- (1,041 distinct ones) which say nothing on their face. For B2B real estate
-- that is the half you most want to know about, and an MX record answers it
-- exactly -- spot-checked against real replier domains:
--
--   realestatewithfox.com   -> Google Workspace
--   ocfrealty.com           -> Google Workspace
--   rodeore.com             -> Microsoft 365
--
-- So this is a measured fact per domain, not an inference from the name. That
-- distinction is the same one that kept "Email Provider" OFF the Leads screen,
-- where only 36% was derivable and a DNS lookup had not been built. Here it has.
--
-- THE DIMENSION MACHINERY IS NOT WIDENED. reply_dimensions already drives every
-- card, and reply_dimension_value's ELSE branch already turns a text value into
-- a label. The ESP is fed into that same slot, so this dimension costs one join
-- in two functions and no signature change anywhere.

BEGIN;

/*
 * CACHE OF DNS, not of EmailBison. One row per domain, refreshed rarely: an
 * organisation changes mail provider once every few years, and a lookup that
 * fails today must not be retried on every reply — hence checked_at, which the
 * job uses as its work queue.
 */
CREATE TABLE IF NOT EXISTS esp_domains (
  domain     TEXT PRIMARY KEY,
  esp        TEXT NOT NULL,
  mx_host    TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE esp_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE esp_domains FORCE  ROW LEVEL SECURITY;
REVOKE ALL ON esp_domains FROM anon, authenticated;

/*
 * The source vocabulary has to admit the new one. It was written when every
 * dimension described the LEAD; this is the first that describes the REPLY.
 */
ALTER TABLE reply_dimensions DROP CONSTRAINT IF EXISTS reply_dimensions_source_check;
ALTER TABLE reply_dimensions ADD CONSTRAINT reply_dimensions_source_check
  CHECK (source IN ('client', 'lead_field', 'lead_attribute', 'reply_esp'));

/*
 * A new dimension source. `client` reads the campaign's client, `lead_field` and
 * `lead_attribute` read the lead; `reply_esp` reads the REPLY itself, which is
 * the first dimension that does.
 */
INSERT INTO reply_dimensions (team_id, key, label, source, source_key, bucket, active, sort_position)
SELECT 2, 'esp', 'Email provider', 'reply_esp', NULL, NULL, TRUE,
       COALESCE((SELECT MAX(sort_position) + 1 FROM reply_dimensions WHERE team_id = 2), 10)
WHERE NOT EXISTS (
  SELECT 1 FROM reply_dimensions WHERE team_id = 2 AND key = 'esp' AND client_id IS NULL
);

CREATE OR REPLACE FUNCTION public.analytics_reply_breakdown(p_team_id bigint, p_from date, p_to date, p_dimension text, p_client_ids uuid[] DEFAULT NULL::uuid[], p_campaign_ids bigint[] DEFAULT NULL::bigint[], p_positive_only boolean DEFAULT false, p_limit integer DEFAULT 12, p_company text[] DEFAULT NULL::text[], p_location text[] DEFAULT NULL::text[], p_sales_volume text[] DEFAULT NULL::text[])
 RETURNS TABLE(value text, replies bigint, positive bigint, sort_order integer, grand_total bigint, group_count bigint)
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  d reply_dimensions%ROWTYPE;
BEGIN
  SELECT * INTO d FROM reply_dimensions
   WHERE team_id = p_team_id AND key = p_dimension AND active
   ORDER BY client_id NULLS LAST LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY
  WITH scoped AS (
    SELECT r.id, r.lead_id, (r.sentiment = 'positive') AS interested, cl.name AS client_name,
           lower(split_part(COALESCE(r.from_email_address, ''), '@', 2)) AS reply_domain
    FROM replies r
    LEFT JOIN campaign_clients cc ON cc.campaign_id = r.campaign_id
    LEFT JOIN clients cl          ON cl.id = cc.client_id
    LEFT JOIN leads l             ON l.id = r.lead_id
    LEFT JOIN lead_attributes city ON city.lead_id = r.lead_id AND city.name = 'office city'
    LEFT JOIN lead_attributes vol  ON vol.lead_id  = r.lead_id AND vol.name  = 'sales volume'
    WHERE r.team_id = p_team_id
      AND r.tracked_reply
      AND NOT r.is_bounce_notification
      AND COALESCE(cc.excluded, FALSE) = FALSE
      AND r.received_date BETWEEN p_from AND p_to
      AND (p_client_ids   IS NULL OR cc.client_id  = ANY(p_client_ids))
      AND (p_campaign_ids IS NULL OR r.campaign_id = ANY(p_campaign_ids))
      AND (NOT p_positive_only OR (r.sentiment = 'positive'))
      AND (p_company      IS NULL OR COALESCE(NULLIF(l.company,''), 'Unknown') = ANY(p_company))
      AND (p_location     IS NULL OR COALESCE(NULLIF(city.value,''), 'Unknown') = ANY(p_location))
      AND (p_sales_volume IS NULL OR currency_band_label(vol.value_numeric) = ANY(p_sales_volume))
  ),
  labelled AS (
    SELECT
      s.interested,
      reply_dimension_value(
        d.source, d.bucket, s.client_name, l.company,
        /*
         * The ESP rides in on the attribute slot rather than widening the
         * signature. reply_dimension_value's ELSE branch already does exactly
         * the right thing with a text value — COALESCE(NULLIF(v,''),'Unknown') —
         * so a new dimension costs a join here and nothing anywhere else.
         */
        COALESCE(esp.esp, la.value), la.value_numeric
      ) AS val,
      CASE WHEN d.bucket = 'currency_bands'
           THEN currency_band_order(la.value_numeric) ELSE 0 END AS ord
    FROM scoped s
    LEFT JOIN leads l ON d.source = 'lead_field' AND l.id = s.lead_id
    LEFT JOIN lead_attributes la
           ON d.source = 'lead_attribute' AND la.lead_id = s.lead_id AND la.name = d.source_key
    LEFT JOIN esp_domains esp
           ON d.source = 'reply_esp' AND esp.domain = s.reply_domain
  ),
  grouped AS (
    SELECT lb.val, COUNT(*) AS n, COUNT(*) FILTER (WHERE lb.interested) AS pos, MIN(lb.ord)::INT AS ord
    FROM labelled lb GROUP BY lb.val
  )
  SELECT g.val, g.n, g.pos, g.ord,
         SUM(g.n) OVER ()::BIGINT,
         COUNT(*) OVER ()::BIGINT
  FROM grouped g
  ORDER BY CASE WHEN d.bucket = 'currency_bands' THEN g.ord END, g.n DESC
  LIMIT p_limit;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.analytics_reply_rows(p_team_id bigint, p_from date, p_to date, p_client_ids uuid[] DEFAULT NULL::uuid[], p_campaign_ids bigint[] DEFAULT NULL::bigint[], p_positive_only boolean DEFAULT false, p_dimension text DEFAULT NULL::text, p_value text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_company text[] DEFAULT NULL::text[], p_location text[] DEFAULT NULL::text[], p_sales_volume text[] DEFAULT NULL::text[], p_sort text DEFAULT NULL::text, p_dir text DEFAULT 'desc'::text)
 RETURNS TABLE(id bigint, date_received timestamp with time zone, from_name text, from_email text, subject text, preview text, interested boolean, automated boolean, campaign_id bigint, campaign_name text, client_name text, lead_id bigint, company text, office_city text, sales_volume text, logged jsonb, total_count bigint)
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  d reply_dimensions%ROWTYPE;
BEGIN
  IF p_dimension IS NOT NULL AND p_value IS NOT NULL THEN
    SELECT * INTO d FROM reply_dimensions
     WHERE team_id = p_team_id AND key = p_dimension AND active
     ORDER BY client_id NULLS LAST LIMIT 1;
  END IF;

  RETURN QUERY
  WITH scoped AS (
    /*
     * 029 deliberately carries only the id and the date here — "pick the page
     * first, decorate second", which is what took this query from 1,190ms to
     * 310ms by not touching text_body 6,083 times to render 50 rows.
     *
     * from_name / from_email / subject are added because ORDER BY has to see
     * what it sorts on. They are three short columns off the same row, no extra
     * join and no large text — the expensive column, text_body, still stays out.
     */
    SELECT r.id, r.date_received, r.from_name, r.from_email_address, r.subject
    FROM replies r
    LEFT JOIN campaign_clients cc ON cc.campaign_id = r.campaign_id
    LEFT JOIN clients cl          ON cl.id = cc.client_id
    LEFT JOIN leads l             ON l.id  = r.lead_id
    LEFT JOIN lead_attributes city ON city.lead_id = r.lead_id AND city.name = 'office city'
    LEFT JOIN lead_attributes vol  ON vol.lead_id  = r.lead_id AND vol.name  = 'sales volume'
    LEFT JOIN lead_attributes dim ON d.source = 'lead_attribute'
                                 AND dim.lead_id = r.lead_id
                                 AND dim.name = d.source_key
    WHERE r.team_id = p_team_id
      AND r.tracked_reply
      AND NOT r.is_bounce_notification
      AND COALESCE(cc.excluded, FALSE) = FALSE
      AND r.received_date BETWEEN p_from AND p_to
      AND (p_client_ids   IS NULL OR cc.client_id  = ANY(p_client_ids))
      AND (p_campaign_ids IS NULL OR r.campaign_id = ANY(p_campaign_ids))
      AND (NOT p_positive_only OR (r.sentiment = 'positive'))
      AND (p_company      IS NULL OR COALESCE(NULLIF(l.company,''), 'Unknown') = ANY(p_company))
      AND (p_location     IS NULL OR COALESCE(NULLIF(city.value,''), 'Unknown') = ANY(p_location))
      AND (p_sales_volume IS NULL OR currency_band_label(vol.value_numeric) = ANY(p_sales_volume))
      AND (
        p_search IS NULL
        OR r.from_email_address ILIKE '%' || p_search || '%'
        OR r.from_name          ILIKE '%' || p_search || '%'
        OR r.subject            ILIKE '%' || p_search || '%'
      )
      AND (
        p_value IS NULL
        OR reply_dimension_value(
             d.source, d.bucket, cl.name, l.company,
             COALESCE(
               (SELECT e.esp FROM esp_domains e
                 WHERE d.source = 'reply_esp'
                   AND e.domain = lower(split_part(COALESCE(r.from_email_address,''), '@', 2))),
               dim.value
             ),
             dim.value_numeric
           ) = p_value
      )
  ),
  page AS (
    SELECT s.id, s.date_received, COUNT(*) OVER () AS total
    FROM scoped s
  ORDER BY
    (CASE WHEN p_dir = 'asc' THEN CASE p_sort
      WHEN 'date_received' THEN (EXTRACT(EPOCH FROM s.date_received))::NUMERIC
    END END) ASC NULLS LAST,
    (CASE WHEN p_dir <> 'asc' THEN CASE p_sort
      WHEN 'date_received' THEN (EXTRACT(EPOCH FROM s.date_received))::NUMERIC
    END END) DESC NULLS LAST,
    (CASE WHEN p_dir = 'asc' THEN CASE p_sort
      WHEN 'from_name' THEN NULLIF(s.from_name, '')
      WHEN 'from_email' THEN NULLIF(s.from_email_address, '')
      WHEN 'subject' THEN NULLIF(s.subject, '')
    END END) ASC NULLS LAST,
    (CASE WHEN p_dir <> 'asc' THEN CASE p_sort
      WHEN 'from_name' THEN NULLIF(s.from_name, '')
      WHEN 'from_email' THEN NULLIF(s.from_email_address, '')
      WHEN 'subject' THEN NULLIF(s.subject, '')
    END END) DESC NULLS LAST,
    s.date_received DESC, s.id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT
    r.id, r.date_received, r.from_name, r.from_email_address, r.subject,
    left(regexp_replace(COALESCE(r.text_body, ''), '\s+', ' ', 'g'), 180),
    (r.sentiment = 'positive'), r.automated_reply, r.campaign_id, c.name, cl.name, r.lead_id,
    l.company, city.value, vol.value,
    COALESCE(
      (SELECT jsonb_agg(oe.event_type ORDER BY oe.event_type)
         FROM outcome_events oe
        WHERE oe.team_id = p_team_id AND NOT oe.voided
          AND oe.id = 'manual:' || r.id || ':' || oe.event_type),
      '[]'::jsonb
    ),
    pg.total
  FROM page pg
  JOIN replies r                 ON r.id = pg.id
  LEFT JOIN campaigns c          ON c.id = r.campaign_id
  LEFT JOIN campaign_clients cc  ON cc.campaign_id = r.campaign_id
  LEFT JOIN clients cl           ON cl.id = cc.client_id
  LEFT JOIN leads l              ON l.id  = r.lead_id
  LEFT JOIN lead_attributes city ON city.lead_id = r.lead_id AND city.name = 'office city'
  LEFT JOIN lead_attributes vol  ON vol.lead_id  = r.lead_id AND vol.name  = 'sales volume'
  ORDER BY r.date_received DESC, r.id;
END;
$function$
;


INSERT INTO schema_migrations (version) VALUES ('059_reply_esp_dimension')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- The resolver's work queue: replier domains never looked up.
CREATE OR REPLACE FUNCTION unresolved_reply_domains(p_team_id BIGINT, p_limit INTEGER DEFAULT 2000)
RETURNS TABLE (domain TEXT)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT lower(split_part(r.from_email_address, '@', 2)) AS domain
  FROM replies r
  WHERE r.team_id = p_team_id
    AND r.tracked_reply
    AND NOT r.is_bounce_notification
    AND r.from_email_address LIKE '%@%'
    AND NOT EXISTS (
      SELECT 1 FROM esp_domains e
       WHERE e.domain = lower(split_part(r.from_email_address, '@', 2))
    )
  LIMIT p_limit;
$$;

NOTIFY pgrst, 'reload schema';
