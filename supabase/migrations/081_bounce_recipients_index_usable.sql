-- 081 — make the recipient-bounce rollup use the indexes that already exist.
--
-- THE INFRASTRUCTURE TAB WAS SERVING AN EMPTY STATE IN PRODUCTION. Not a slow
-- page — an empty one: `analytics_bounce_recipients` exceeded the statement
-- timeout, the route surfaces the first error of its eight parallel calls, and
-- the whole EmailBison estate rendered as "0 domains / Nothing to show. Run
-- sync-senders if this is unexpected." The suggested remedy was for a different
-- problem, so the message actively pointed away from the cause.
--
-- The tables are small — 85K leads, 189K campaign_leads, 12.6K replies — and
-- 061's own logic was right. Only the predicates were unusable:
--
--     EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.lead_id = l.id)
--     OR EXISTS (SELECT 1 FROM replies r      WHERE r.lead_id = l.id)
--
-- `idx_cl_lead` is (team_id, lead_id) and `idx_replies_lead` is (team_id,
-- lead_id, date_received). Both LEAD with team_id, and neither EXISTS
-- constrains it, so neither index can be used — each becomes a scan, once per
-- candidate lead, and the OR keeps the planner from turning either into a hash
-- semi-join. 120+ seconds, against a 439ms answer.
--
-- Two changes, both mechanical:
--   1. `team_id = p_team_id` inside each membership test, so the leading index
--      column is bound.
--   2. The OR of two EXISTS becomes `IN (… UNION …)` — one hash semi-join
--      against a small deduplicated set, instead of two correlated subplans
--      the planner will not merge.
--
-- VERIFIED TO CHANGE NO ROWS, which is the only thing that makes this safe to
-- call an optimisation. Constraining team_id could in principle drop a lead
-- whose membership row belongs to another team; it does not. Both formulations
-- select the same 84,687 leads, and EXCEPT in both directions returns zero.
--
-- Nothing about the denominator reasoning in 061 changes — that comment is
-- still the authority on WHY the population is shaped this way. This only
-- changes how the same population is fetched.

BEGIN;

DROP FUNCTION IF EXISTS analytics_bounce_recipients(BIGINT, TEXT, INTEGER, INTEGER);

CREATE FUNCTION analytics_bounce_recipients(
  p_team_id   BIGINT,
  p_group     TEXT    DEFAULT 'esp',   -- esp | domain
  p_min_leads INTEGER DEFAULT 50,
  p_limit     INTEGER DEFAULT 15
)
RETURNS TABLE (
  label     TEXT,
  leads     BIGINT,   -- distinct leads at this provider we have contacted
  bounced   BIGINT,   -- distinct leads among them that ever bounced
  events    BIGINT,   -- bounce notifications, which exceed leads
  rate      NUMERIC,
  domains   BIGINT
)
LANGUAGE sql STABLE AS $function$
  WITH contacted AS (
    /*
     * Evidence of contact, not merely of existence: a campaign_leads row or any
     * reply. Leads we hold but never mailed would dilute every rate.
     *
     * Expressed as one semi-join against a deduplicated id set rather than two
     * OR'd EXISTS — same population (proven), but the planner can hash it.
     */
    SELECT l.id, lower(split_part(l.email, '@', 2)) AS rcpt_domain
    FROM leads l
    WHERE l.team_id = p_team_id
      AND l.email LIKE '%@%'
      AND l.id IN (
        SELECT cl.lead_id FROM campaign_leads cl WHERE cl.team_id = p_team_id
        UNION
        SELECT r.lead_id FROM replies r
        WHERE r.team_id = p_team_id AND r.lead_id IS NOT NULL
      )
  ),
  bounces AS (
    SELECT r.lead_id, COUNT(*) AS events
    FROM replies r
    WHERE r.team_id = p_team_id AND r.is_bounce_notification
    GROUP BY 1
  ),
  keyed AS (
    SELECT
      CASE WHEN p_group = 'domain' THEN c.rcpt_domain
           ELSE COALESCE(e.esp, 'Not resolved') END AS label,
      c.id,
      c.rcpt_domain,
      COALESCE(b.events, 0) AS events
    FROM contacted c
    LEFT JOIN esp_domains e ON e.domain = c.rcpt_domain
    LEFT JOIN bounces b     ON b.lead_id = c.id
  )
  SELECT
    k.label,
    COUNT(*),
    COUNT(*) FILTER (WHERE k.events > 0),
    SUM(k.events),
    -- Both sides are distinct leads from the same population, so this is a
    -- share and cannot exceed 1.
    COUNT(*) FILTER (WHERE k.events > 0)::NUMERIC / COUNT(*),
    COUNT(DISTINCT k.rcpt_domain)
  FROM keyed k
  GROUP BY 1
  /*
   * A floor, for the same reason the sending side has one: a provider with four
   * contacted leads and one bounce is 25% and means nothing.
   */
  HAVING COUNT(*) >= p_min_leads
  ORDER BY COUNT(*) FILTER (WHERE k.events > 0)::NUMERIC / COUNT(*) DESC,
           COUNT(*) FILTER (WHERE k.events > 0) DESC
  LIMIT p_limit;
$function$;

INSERT INTO schema_migrations (version) VALUES ('081_bounce_recipients_index_usable')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
