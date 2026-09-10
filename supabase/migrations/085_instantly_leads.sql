-- 085 — Instantly's leads, so its campaigns have a Leads tab at all.
--
-- Lead removal already works on Instantly (DELETE /leads, verified), but there
-- was nothing to select FROM: the Leads tab reads EmailBison's lead tables, so
-- an Instantly campaign showed an empty list. Wiring the button without this
-- would have been a control with nothing to act on.
--
-- ONE WALK GIVES MEMBERSHIP FOR FREE. `POST /leads/list` with no campaign
-- filter returns every lead WITH its `campaign`, so there is no per-campaign
-- fan-out and no join table — the campaign is a column on the lead. 40,482
-- leads at 100 a page is ~405 calls and about 4.4 minutes measured, which is
-- why the job is resumable rather than all-or-nothing (the runner's stale lock
-- is 10 minutes).
--
-- STATUS IS STORED RAW AND DERIVED SEPARATELY, and that separation is the
-- point. Instantly's lead status is an integer with no legend in its OpenAPI
-- spec — the codes seen are 1, 3, -1 and -3, and the spec explains none of
-- them. Guessing that -1 is "bounced" would put a confident wrong word on
-- screen, which is the failure this codebase keeps finding. So the integer is
-- kept for filtering and inspection, and the DISPLAYED status is derived from
-- evidence the same way EmailBison's is (055): a reply is a reply, a contact
-- timestamp is a contact.
--
-- Bounced is deliberately absent from that derivation. /leads/list carries no
-- per-lead bounce signal, and inferring one from a status code nobody has
-- documented would be exactly the guess this comment refuses.

BEGIN;

CREATE TABLE IF NOT EXISTS instantly_leads (
  id                  UUID PRIMARY KEY,
  team_id             BIGINT NOT NULL,
  campaign_id         UUID,
  email               TEXT,
  first_name          TEXT,
  last_name           TEXT,
  company_name        TEXT,
  company_domain      TEXT,
  -- Instantly's own code, undocumented. Kept, never rendered as a word.
  status              INTEGER,
  esp_code            INTEGER,
  email_reply_count   INTEGER NOT NULL DEFAULT 0,
  email_open_count    INTEGER NOT NULL DEFAULT 0,
  email_click_count   INTEGER NOT NULL DEFAULT 0,
  last_contact_at     TIMESTAMPTZ,
  eb_created_at       TIMESTAMPTZ,
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inst_leads_campaign
  ON instantly_leads (team_id, campaign_id);
CREATE INDEX IF NOT EXISTS idx_inst_leads_email
  ON instantly_leads (team_id, email);

/*
 * A resumable cursor for jobs that page through an opaque string cursor.
 * sync_state has cursor_date (a date) and cursor_id (a bigint); neither can
 * hold `starting_after`, which is a uuid-shaped token.
 */
ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS cursor_text TEXT;

/*
 * The Leads tab's rows, with the same shape and the same derived vocabulary as
 * analytics_campaign_lead_rows so the table component does not need to know
 * which platform it is rendering.
 *
 * `replied` before `contacted` for the same reason 055 orders its CASE that
 * way: a lead who replied was obviously contacted, and the more specific fact
 * is the one worth showing.
 */
CREATE OR REPLACE FUNCTION analytics_instantly_lead_rows(
  p_team_id     BIGINT,
  p_campaign_id UUID,
  p_search      TEXT    DEFAULT NULL,
  p_status      TEXT[]  DEFAULT NULL,
  p_limit       INTEGER DEFAULT 100,
  p_offset      INTEGER DEFAULT 0
)
RETURNS TABLE (
  lead_id      UUID,
  email        TEXT,
  first_name   TEXT,
  last_name    TEXT,
  company      TEXT,
  status       TEXT,
  raw_status   INTEGER,
  replies      INTEGER,
  opens        INTEGER,
  last_sent_at TIMESTAMPTZ,
  total_count  BIGINT
)
LANGUAGE sql STABLE AS $function$
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
  ORDER BY f.last_contact_at DESC NULLS LAST, f.email
  LIMIT p_limit OFFSET p_offset;
$function$;

/*
 * Every matching lead id in ONE ROW holding an array, like
 * analytics_campaign_lead_ids — a plain select is capped at 1,000 by PostgREST
 * (rule 7), and "select all and remove" is exactly the operation that would
 * silently act on the first thousand of six thousand.
 */
CREATE OR REPLACE FUNCTION analytics_instantly_lead_ids(
  p_team_id     BIGINT,
  p_campaign_id UUID,
  p_search      TEXT   DEFAULT NULL,
  p_status      TEXT[] DEFAULT NULL
)
RETURNS UUID[]
LANGUAGE sql STABLE AS $function$
  SELECT COALESCE(ARRAY_AGG(r.lead_id), '{}')
  FROM analytics_instantly_lead_rows(
    p_team_id, p_campaign_id, p_search, p_status, 2147483647, 0
  ) r;
$function$;

INSERT INTO schema_migrations (version) VALUES ('085_instantly_leads')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
