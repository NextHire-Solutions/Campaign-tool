-- 088 — surface Instantly's replies, and stop the Replies view lying about them.
--
-- THE BUG THIS CLOSES: /api/analytics/replies* ignored `platforms` entirely.
-- Selecting Instantly returned 5,761 EMAILBISON replies under an Instantly
-- label — identical totals under every platform, which is the tell. Meanwhile
-- 17,732 Instantly replies sat synced and unused. Same failure as the campaign
-- filter leak: a filter that is silently dropped shows one platform's data as
-- the other's, and it fails upward because the numbers look plausible.
--
-- WHAT INSTANTLY CAN AND CANNOT ANSWER, stated once here so the UI does not
-- have to guess:
--
--   CAN   who replied (address), which campaign, when, subject and preview,
--         the client (through instantly_campaign_clients), the recipient's
--         email provider (through esp_domains on the address domain), and
--         whether the mailbox is personal or professional.
--   CANNOT  location, sales volume, MLS, current brokerage. Those are
--         EmailBison LEAD ATTRIBUTES from an enriched import; Instantly's
--         leads carry a name, a company and a domain and nothing else.
--
-- Those dimensions return NO ROWS for Instantly rather than borrowing
-- EmailBison's, which is exactly the substitution this migration exists to
-- prevent. A card with no rows says "not available for this platform"; a card
-- filled with the other platform's people says something false.

BEGIN;

/*
 * One reply row, shaped like analytics_reply_rows so the list component needs
 * no second renderer.
 */
CREATE OR REPLACE FUNCTION analytics_instantly_reply_rows(
  p_team_id      BIGINT,
  p_from         DATE,
  p_to           DATE,
  p_client_ids   UUID[]  DEFAULT NULL,
  p_search       TEXT    DEFAULT NULL,
  p_dimension    TEXT    DEFAULT NULL,
  p_value        TEXT    DEFAULT NULL,
  p_limit        INTEGER DEFAULT 50,
  p_offset       INTEGER DEFAULT 0
)
RETURNS TABLE (
  reply_id        TEXT,
  received_date   DATE,
  from_email      TEXT,
  lead_name       TEXT,
  company         TEXT,
  campaign_name   TEXT,
  client_name     TEXT,
  subject         TEXT,
  preview         TEXT,
  esp             TEXT,
  mailbox_kind    TEXT,
  total_count     BIGINT
)
LANGUAGE sql STABLE AS $function$
  WITH base AS (
    SELECT
      r.id::TEXT                                   AS reply_id,
      r.received_date,
      r.lead_email                                 AS from_email,
      NULLIF(TRIM(COALESCE(l.first_name,'') || ' ' || COALESCE(l.last_name,'')), '') AS lead_name,
      l.company_name                               AS company,
      ic.name                                      AS campaign_name,
      cl.name                                      AS client_name,
      r.subject,
      r.preview,
      COALESCE(e.esp, 'Unknown')                   AS esp,
      /*
       * THE SAME AUTHORITY EMAILBISON USES — consumer_email_domains (063).
       *
       * A first attempt matched `esp IN ('Google','Microsoft',…)` against a
       * hardcoded free-domain list, and got Personal 37 vs Professional 4,311:
       * the esp values are 'Google Workspace' and 'Microsoft 365', so the test
       * almost never fired. Two platforms answering "personal or work" from two
       * different rules would produce cards that cannot be compared, which is
       * the whole reason this split exists.
       */
      CASE
        WHEN lower(split_part(COALESCE(r.lead_email, ''), '@', 2)) = '' THEN 'Unknown'
        WHEN EXISTS (
          SELECT 1 FROM consumer_email_domains ced
          WHERE ced.domain = lower(split_part(r.lead_email, '@', 2))
        ) THEN 'Personal'
        ELSE 'Professional'
      END                                          AS mailbox_kind
    FROM instantly_replies r
    JOIN instantly_campaigns ic                ON ic.id = r.campaign_id
    LEFT JOIN instantly_campaign_clients icc   ON icc.campaign_id = r.campaign_id
    LEFT JOIN clients cl                       ON cl.id = icc.client_id
    LEFT JOIN instantly_leads l                ON l.email = r.lead_email AND l.team_id = r.team_id
    LEFT JOIN esp_domains e                    ON e.domain = lower(split_part(r.lead_email, '@', 2))
    WHERE r.team_id = p_team_id
      AND r.received_date BETWEEN p_from AND p_to
      AND COALESCE(icc.excluded, FALSE) = FALSE
      AND (p_client_ids IS NULL OR icc.client_id = ANY(p_client_ids))
  ),
  searched AS (
    SELECT * FROM base b
    WHERE p_search IS NULL OR p_search = ''
       OR b.from_email ILIKE '%' || p_search || '%'
       OR COALESCE(b.lead_name,'')     ILIKE '%' || p_search || '%'
       OR COALESCE(b.company,'')       ILIKE '%' || p_search || '%'
       OR COALESCE(b.subject,'')       ILIKE '%' || p_search || '%'
       OR COALESCE(b.campaign_name,'') ILIKE '%' || p_search || '%'
  ),
  drilled AS (
    SELECT * FROM searched s
    WHERE p_dimension IS NULL OR p_value IS NULL
       OR (p_dimension = 'brokerage'    AND COALESCE(s.client_name, 'Unknown') = p_value)
       OR (p_dimension = 'company'      AND COALESCE(s.company, 'Unknown') = p_value)
       OR (p_dimension = 'esp'          AND s.esp = p_value)
       OR (p_dimension = 'mailbox_kind' AND s.mailbox_kind = p_value)
  )
  SELECT
    d.reply_id, d.received_date, d.from_email, d.lead_name, d.company,
    d.campaign_name, d.client_name, d.subject, d.preview, d.esp, d.mailbox_kind,
    COUNT(*) OVER () AS total_count
  FROM drilled d
  ORDER BY d.received_date DESC, d.reply_id
  LIMIT p_limit OFFSET p_offset;
$function$;

/*
 * The breakdown cards. Only the four dimensions Instantly can actually answer;
 * a request for one of the others returns no rows, which the UI renders as
 * "not available on this platform" rather than as an empty finding.
 */
CREATE OR REPLACE FUNCTION analytics_instantly_reply_breakdown(
  p_team_id    BIGINT,
  p_from       DATE,
  p_to         DATE,
  p_dimension  TEXT,
  p_client_ids UUID[] DEFAULT NULL,
  p_limit      INTEGER DEFAULT 12
)
RETURNS TABLE (value TEXT, replies BIGINT, positive BIGINT)
LANGUAGE sql STABLE AS $function$
  SELECT
    v.value,
    COUNT(*)::BIGINT,
    /*
     * Zero, and honestly so. "Positive" is a MasterInbox label keyed to
     * EmailBison reply ids; no Instantly reply has one. The KPI band already
     * dashes Positive whenever Instantly is in scope for the same reason.
     */
    0::BIGINT
  FROM (
    SELECT
      CASE p_dimension
        WHEN 'brokerage'    THEN COALESCE(r.client_name, 'Unknown')
        WHEN 'company'      THEN COALESCE(r.company, 'Unknown')
        WHEN 'esp'          THEN r.esp
        WHEN 'mailbox_kind' THEN r.mailbox_kind
        ELSE NULL
      END AS value
    FROM analytics_instantly_reply_rows(
      p_team_id, p_from, p_to, p_client_ids, NULL, NULL, NULL, 2147483647, 0
    ) r
  ) v
  WHERE v.value IS NOT NULL
  GROUP BY v.value
  ORDER BY 2 DESC
  LIMIT p_limit;
$function$;

CREATE INDEX IF NOT EXISTS idx_inst_replies_date
  ON instantly_replies (team_id, received_date DESC);

INSERT INTO schema_migrations (version) VALUES ('088_instantly_replies_view')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
