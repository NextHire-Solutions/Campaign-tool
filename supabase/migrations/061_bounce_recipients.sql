-- 061 — where our bounces LAND: the recipient's provider and domain.
--
-- Infrastructure already answers the sending side — bounce rate per sending
-- domain, per provider, per inbox. It cannot answer the other half: whose mail
-- servers are rejecting us. Those need opposite responses. A sending domain
-- bouncing hard is an infrastructure problem you fix by pausing an inbox; a
-- RECIPIENT provider bouncing hard is a list problem, and no amount of inbox
-- warming touches it.
--
-- THE JOIN IS DIFFERENT FROM THE REPLIES ESP CARD, AND IT HAS TO BE.
-- 059's card reads `from_email_address` — the person who replied. On a bounce
-- that field is the MAILER-DAEMON (`mailer-daemon@googlemail.com`), so reusing
-- it would report that Google bounces everything. The recipient is reached
-- through `lead_id` instead, which every bounce row carries.
--
-- WIDENING THE DNS QUEUE WAS THE PREREQUISITE. esp_domains was filled from
-- REPLIER domains only, so a domain that bounced and never replied was never
-- looked up — 3,673 of 6,498 bounce rows had no provider. 583 new domains, one
-- DNS lookup each, no EmailBison budget. Now 100% resolved.
--
-- ---------------------------------------------------------------------------
-- THE DENOMINATOR, WHICH TOOK THREE ATTEMPTS AND IS THE WHOLE DESIGN.
--
-- A count alone ranks providers by how much of each is in the list — a fact
-- about the list, not about the provider. So it has to be a rate, and the
-- denominator decides whether the rate means anything.
--
--   1. Bounce ROWS over leads contacted → rates of 229%, 950%, 3580%. Wrong
--      twice over: a dead mailbox emits one bounce PER SEND (6,498 rows over
--      5,601 leads), so the numerator double-counts.
--
--   2. Denominator from campaign_leads → still wrong, and wrong in the worst
--      possible direction. Only 1,580 of 5,601 bounced leads appear there:
--      that table is built from scheduled-emails, and a lead whose first send
--      hard-bounced often has no surviving sent row. It systematically omits
--      exactly the leads the numerator counts, so it inflates every rate at
--      precisely the providers that bounce most.
--
--   3. What ships: BOTH SIDES FROM THE SAME POPULATION. Distinct leads that
--      bounced, over distinct leads at that provider we have evidence of
--      contacting — a campaign_leads row or any reply. A bounce IS a reply row,
--      so a bounced lead is inside the denominator by construction and the rate
--      cannot exceed 100%. Verified: no rate over 100%, Mimecast 91.15%.
--
-- LIFETIME, NOT DATE-FILTERED, AND DELIBERATELY. A windowed numerator over a
-- lifetime denominator understates every short range; windowing the denominator
-- needs a per-lead first-contact date that attempt 2 just showed we do not
-- reliably have. Infrastructure is already lifetime and says so on screen, which
-- is the page this belongs on and why it belongs there.

BEGIN;

/*
 * The DNS work queue gains the bouncing domains.
 *
 * Kept under its original name so the job that drains it and the schedule that
 * runs it do not have to move together. What it now means is "domains we have
 * an opinion to form about", from both directions.
 */
CREATE OR REPLACE FUNCTION public.unresolved_reply_domains(
  p_team_id bigint,
  p_limit integer DEFAULT 2000
)
RETURNS TABLE(domain text)
LANGUAGE sql STABLE AS $function$
  WITH wanted AS (
    -- Who replied to us (059's original queue).
    SELECT DISTINCT lower(split_part(r.from_email_address, '@', 2)) AS domain
    FROM replies r
    WHERE r.team_id = p_team_id
      AND r.tracked_reply
      AND NOT r.is_bounce_notification
      AND r.from_email_address LIKE '%@%'

    UNION

    -- Who rejected us. Read from the LEAD, never from the bounce's own
    -- from-address, which is the postmaster and not the recipient.
    SELECT DISTINCT lower(split_part(l.email, '@', 2))
    FROM replies r
    JOIN leads l ON l.id = r.lead_id
    WHERE r.team_id = p_team_id
      AND r.is_bounce_notification
      AND l.email LIKE '%@%'
  )
  SELECT w.domain
  FROM wanted w
  WHERE w.domain <> ''
    AND NOT EXISTS (SELECT 1 FROM esp_domains e WHERE e.domain = w.domain)
  LIMIT p_limit;
$function$;

DROP FUNCTION IF EXISTS analytics_bounce_recipients(BIGINT, DATE, DATE, TEXT, UUID[], BIGINT[], INTEGER);

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
     */
    SELECT l.id, lower(split_part(l.email, '@', 2)) AS rcpt_domain
    FROM leads l
    WHERE l.team_id = p_team_id
      AND l.email LIKE '%@%'
      AND (
        EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.lead_id = l.id)
        OR EXISTS (SELECT 1 FROM replies r WHERE r.lead_id = l.id)
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
   * contacted leads and one bounce is 25% and means nothing. It is the control
   * that turned "254 critical domains" into zero on the sending side.
   */
  HAVING COUNT(*) >= p_min_leads
  ORDER BY COUNT(*) FILTER (WHERE k.events > 0)::NUMERIC / COUNT(*) DESC,
           COUNT(*) FILTER (WHERE k.events > 0) DESC
  LIMIT p_limit;
$function$;

INSERT INTO schema_migrations (version) VALUES ('061_bounce_recipients')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
