-- 060 — who SOLD us each inbox, and which inboxes are dead.
--
-- Two questions the Infrastructure tab could not answer, plus one bug found
-- while answering them.
--
-- ---------------------------------------------------------------------------
-- 1. THE VENDOR IS IN EMAILBISON ALREADY, AS A TAG.
--
-- /api/sender-emails returns `tags[]`, and the estate was tagged on 27-28 Aug.
-- Walked all 1,496 inboxes; the vocabulary is three distinct kinds of tag:
--
--   system  (default:true)  Google · Custom Mail Server · Interested
--   pool                    Nicole Pool 534 · Nicole Pool 2 316 ·
--                           BrokerStaffer 120 · Howe Realty 48
--   vendor                  LeadGenJay 534 · cheapinboxes 450 · Zapmail 449 ·
--                           Maildoso 30 · Mission Inbox 30      = 1,493 of 1,496
--
-- and a parallel `p.` namespace: p.LeadGenJay Google, p.Cheapinboxes Google,
-- p.Zapmail Google, p.Maildoso Custom, p.Mission Inbox Custom / Google.
--
-- THE `p.` PREFIX IS THE RULE, not a list of five names. Hard-coding the five
-- would make a sixth vendor silently vanish into "untagged" — the failure that
-- looks like success, because the table would still add up. The prefix is a
-- deliberate namespace: every vendor has one and no system or pool tag does.
-- The trailing word (Google / Custom) is the CONNECTION type, which `provider`
-- already records; keeping it would split one vendor across two rows.
--
-- VERIFIED BEFORE BUILDING: 0 inboxes carry two vendor tags, 0 carry two `p.`
-- tags, and the bare and `p.` tags never disagree. Vendor is therefore
-- single-valued, which is what lets vendor totals sum to the estate. If that
-- ever stops being true the "Untagged" row is where it will show up.
--
-- ---------------------------------------------------------------------------
-- 2. DISCONNECTED INBOXES — the data was already here, never surfaced.
--
-- 1,440 Connected · 61 Not connected · 3 Failed. Concentrated by vendor:
-- cheapinboxes 48, Mission Inbox 6, LeadGenJay 3 (Failed) — which is only
-- visible once the vendor exists, and is the reason these two ship together.
--
-- ---------------------------------------------------------------------------
-- 3. THE BUG: syncSenders upserts but never reconciles deletions.
--
-- EmailBison returns 1,496 inboxes (page mode and cursor mode agree exactly).
-- sender_emails holds 1,504. The 8 extra were deleted upstream on 27 Aug and
-- SEVEN OF THEM ARE "Not connected" — someone deleted them precisely because
-- they were dead. So the disconnected list would have opened at 64 when the
-- truth is 57, and 7 of those could never be fixed because they do not exist.
-- The first thing this feature does would have been to send someone hunting
-- for ghosts.
--
-- Archived, not deleted: campaign_lead_sends.sender_email_id and
-- campaign_leads.sender_email_id both point here (no FK, but the history is
-- real), and a deleted inbox's past sends still happened. Every read path
-- excludes archived rows; the history keeps its referent.

BEGIN;

ALTER TABLE sender_emails ADD COLUMN IF NOT EXISTS vendor      TEXT;
ALTER TABLE sender_emails ADD COLUMN IF NOT EXISTS tags        TEXT[];
ALTER TABLE sender_emails ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- Every read path filters on this, and it is highly selective (8 of 1,504).
CREATE INDEX IF NOT EXISTS idx_sender_emails_live
  ON sender_emails (team_id) WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sender_emails_vendor
  ON sender_emails (team_id, vendor) WHERE archived_at IS NULL;

/*
 * "When did this inbox go dark." campaign_lead_sends had no index on the
 * sender, only (campaign_id, lead_id) and (team_id, sent_at) — so asking for
 * one mailbox's last send meant a scan of 422,555 rows.
 */
CREATE INDEX IF NOT EXISTS idx_cls_sender
  ON campaign_lead_sends (sender_email_id, sent_at DESC);

-- --------------------------------------------------------------------------
-- The inbox table: vendor as a column, a filter, and a sort.
-- --------------------------------------------------------------------------

DROP FUNCTION IF EXISTS analytics_sender_rows(BIGINT, INTEGER, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT[], TEXT[], TEXT[]);

CREATE FUNCTION analytics_sender_rows(
  p_team_id   BIGINT,
  p_min_sent  INTEGER DEFAULT 0,
  p_search    TEXT    DEFAULT NULL,
  p_sort      TEXT    DEFAULT 'sent',
  p_limit     INTEGER DEFAULT 200,
  p_offset    INTEGER DEFAULT 0,
  p_dir       TEXT    DEFAULT 'desc',
  p_bands     TEXT[]  DEFAULT NULL,
  p_providers TEXT[]  DEFAULT NULL,
  p_statuses  TEXT[]  DEFAULT NULL,
  p_vendors   TEXT[]  DEFAULT NULL
)
RETURNS TABLE(
  id bigint, email text, name text, domain text, provider text, status text,
  vendor text, daily_limit integer, sent integer, bounced integer,
  replied integer, bounce_rate numeric, reply_rate numeric, total_count bigint
)
LANGUAGE sql STABLE AS $function$
  WITH filtered AS (
    SELECT s.*
    FROM sender_emails s
    WHERE s.team_id = p_team_id
      AND s.archived_at IS NULL
      AND COALESCE(s.lifetime_sent, 0) >= p_min_sent
      AND (p_search IS NULL OR s.email ILIKE '%' || p_search || '%'
                            OR COALESCE(s.domain, '') ILIKE '%' || p_search || '%'
                            OR COALESCE(s.vendor, '') ILIKE '%' || p_search || '%')
      AND (p_providers IS NULL OR COALESCE(s.provider, 'unknown')  = ANY(p_providers))
      AND (p_statuses  IS NULL OR COALESCE(s.status,   'unknown')  = ANY(p_statuses))
      -- 'untagged' is a real, selectable value: an inbox nobody attributed is
      -- exactly the thing you want to be able to list.
      AND (p_vendors   IS NULL OR COALESCE(s.vendor,   'untagged') = ANY(p_vendors))
      /*
       * The health band, from the same 2%/3% thresholds the summary card draws.
       * An inbox that has never sent belongs to NO band -- it has no bounce rate,
       * only an absence of one, and putting it in "healthy" would count silence
       * as good news.
       */
      AND (p_bands IS NULL OR (
        CASE
          WHEN COALESCE(s.lifetime_sent, 0) = 0 THEN 'unsent'
          WHEN s.lifetime_bounced::NUMERIC / s.lifetime_sent >= 0.03 THEN 'high'
          WHEN s.lifetime_bounced::NUMERIC / s.lifetime_sent >= 0.02 THEN 'watch'
          ELSE 'ok'
        END
      ) = ANY(p_bands))
  )
  SELECT
    f.id, f.email, f.name, f.domain, f.provider, f.status, f.vendor, f.daily_limit,
    COALESCE(f.lifetime_sent, 0),
    COALESCE(f.lifetime_bounced, 0),
    COALESCE(f.unique_replied, 0),
    -- NULL, not 0, when nothing was sent: "no data" and "a 0% bounce rate" are
    -- different facts, and DASH is how the first one reaches the DOM.
    CASE WHEN COALESCE(f.lifetime_sent, 0) > 0
         THEN f.lifetime_bounced::NUMERIC / f.lifetime_sent END,
    CASE WHEN COALESCE(f.lifetime_sent, 0) > 0
         THEN f.unique_replied::NUMERIC / f.lifetime_sent END,
    COUNT(*) OVER ()
  FROM filtered f
  ORDER BY
    (CASE WHEN p_dir = 'asc' THEN CASE p_sort
      WHEN 'sent' THEN (COALESCE(f.lifetime_sent, 0))::NUMERIC
      WHEN 'bounced' THEN (COALESCE(f.lifetime_bounced, 0))::NUMERIC
      WHEN 'bounce_rate' THEN (CASE WHEN COALESCE(f.lifetime_sent,0) > 0 THEN f.lifetime_bounced::NUMERIC / f.lifetime_sent END)::NUMERIC
      WHEN 'reply_rate' THEN (CASE WHEN COALESCE(f.lifetime_sent,0) > 0 THEN f.unique_replied::NUMERIC / f.lifetime_sent END)::NUMERIC
      WHEN 'daily_limit' THEN (COALESCE(f.daily_limit, 0))::NUMERIC
    END END) ASC NULLS LAST,
    (CASE WHEN p_dir <> 'asc' THEN CASE p_sort
      WHEN 'sent' THEN (COALESCE(f.lifetime_sent, 0))::NUMERIC
      WHEN 'bounced' THEN (COALESCE(f.lifetime_bounced, 0))::NUMERIC
      WHEN 'bounce_rate' THEN (CASE WHEN COALESCE(f.lifetime_sent,0) > 0 THEN f.lifetime_bounced::NUMERIC / f.lifetime_sent END)::NUMERIC
      WHEN 'reply_rate' THEN (CASE WHEN COALESCE(f.lifetime_sent,0) > 0 THEN f.unique_replied::NUMERIC / f.lifetime_sent END)::NUMERIC
      WHEN 'daily_limit' THEN (COALESCE(f.daily_limit, 0))::NUMERIC
    END END) DESC NULLS LAST,
    (CASE WHEN p_dir = 'asc' THEN CASE p_sort
      WHEN 'email' THEN NULLIF(f.email, '')
      WHEN 'domain' THEN NULLIF(f.domain, '')
      WHEN 'provider' THEN NULLIF(f.provider, '')
      WHEN 'status' THEN NULLIF(f.status, '')
      WHEN 'vendor' THEN NULLIF(f.vendor, '')
    END END) ASC NULLS LAST,
    (CASE WHEN p_dir <> 'asc' THEN CASE p_sort
      WHEN 'email' THEN NULLIF(f.email, '')
      WHEN 'domain' THEN NULLIF(f.domain, '')
      WHEN 'provider' THEN NULLIF(f.provider, '')
      WHEN 'status' THEN NULLIF(f.status, '')
      WHEN 'vendor' THEN NULLIF(f.vendor, '')
    END END) DESC NULLS LAST,
    COALESCE(f.lifetime_sent, 0) DESC, f.id
  LIMIT p_limit OFFSET p_offset;
$function$;

-- --------------------------------------------------------------------------
-- The rollups: a third grouping, and the same vendor filter.
-- --------------------------------------------------------------------------

DROP FUNCTION IF EXISTS analytics_sender_groups(BIGINT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT[], TEXT[], TEXT[], INTEGER);

CREATE FUNCTION analytics_sender_groups(
  p_team_id   BIGINT,
  p_group     TEXT    DEFAULT 'domain',   -- domain | provider | vendor
  p_min_sent  INTEGER DEFAULT 0,
  p_sort      TEXT    DEFAULT NULL,
  p_dir       TEXT    DEFAULT 'desc',
  p_search    TEXT    DEFAULT NULL,
  p_bands     TEXT[]  DEFAULT NULL,
  p_providers TEXT[]  DEFAULT NULL,
  p_statuses  TEXT[]  DEFAULT NULL,
  p_min_total INTEGER DEFAULT 0,
  p_vendors   TEXT[]  DEFAULT NULL
)
RETURNS TABLE (
  label       TEXT,
  inboxes     BIGINT,
  sent        BIGINT,
  bounced     BIGINT,
  replied     BIGINT,
  bounce_rate NUMERIC,
  reply_rate  NUMERIC,
  -- Only meaningful on the vendor view, where "how many of the inboxes I sold
  -- you are dead" is the whole question. Zero elsewhere.
  disconnected BIGINT
)
LANGUAGE sql STABLE AS $function$
  WITH grouped AS (
    SELECT
      COALESCE(
        CASE
          WHEN p_group = 'provider' THEN s.provider
          -- Untagged is spelled out rather than left as 'unknown': it means
          -- "nobody has said who sold us this", which is actionable, where
          -- 'unknown' reads like a data error.
          WHEN p_group = 'vendor'   THEN COALESCE(s.vendor, 'Untagged')
          ELSE s.domain
        END,
        'unknown'
      ) AS label,
      COUNT(*)                             AS inboxes,
      SUM(COALESCE(s.lifetime_sent, 0))    AS sent,
      SUM(COALESCE(s.lifetime_bounced, 0)) AS bounced,
      SUM(COALESCE(s.unique_replied, 0))   AS replied,
      COUNT(*) FILTER (WHERE COALESCE(s.status, '') <> 'Connected') AS disconnected
    FROM sender_emails s
    WHERE s.team_id = p_team_id
      AND s.archived_at IS NULL
      AND COALESCE(s.lifetime_sent, 0) >= p_min_sent
      /*
       * Search, provider and status match the INBOX rows, before grouping, so a
       * matched domain's totals are the totals of the inboxes that matched. The
       * band and the volume floor are properties of the GROUP, so they are
       * applied after it -- a domain is critical because the domain bounces,
       * not because one of its mailboxes does.
       */
      AND (
        p_search IS NULL
        OR s.domain   ILIKE '%' || p_search || '%'
        OR s.email    ILIKE '%' || p_search || '%'
        OR s.provider ILIKE '%' || p_search || '%'
        OR COALESCE(s.vendor, '') ILIKE '%' || p_search || '%'
      )
      AND (p_providers IS NULL OR COALESCE(s.provider, 'unknown')  = ANY(p_providers))
      AND (p_statuses  IS NULL OR COALESCE(s.status,   'unknown')  = ANY(p_statuses))
      AND (p_vendors   IS NULL OR COALESCE(s.vendor,   'untagged') = ANY(p_vendors))
    GROUP BY 1
    HAVING SUM(COALESCE(s.lifetime_sent, 0)) >= p_min_total
       AND (p_bands IS NULL OR (
         CASE
           WHEN SUM(COALESCE(s.lifetime_sent, 0)) = 0 THEN 'unsent'
           WHEN SUM(COALESCE(s.lifetime_bounced, 0))::NUMERIC
                / SUM(COALESCE(s.lifetime_sent, 0)) >= 0.03 THEN 'high'
           WHEN SUM(COALESCE(s.lifetime_bounced, 0))::NUMERIC
                / SUM(COALESCE(s.lifetime_sent, 0)) >= 0.02 THEN 'watch'
           ELSE 'ok'
         END
       ) = ANY(p_bands))
  )
  SELECT
    g.label, g.inboxes, g.sent, g.bounced, g.replied,
    CASE WHEN g.sent > 0 THEN g.bounced::NUMERIC / g.sent END,
    CASE WHEN g.sent > 0 THEN g.replied::NUMERIC / g.sent END,
    g.disconnected
  FROM grouped g
  ORDER BY
    (CASE WHEN p_dir = 'asc' THEN CASE p_sort
      WHEN 'sent'         THEN g.sent::NUMERIC
      WHEN 'inboxes'      THEN g.inboxes::NUMERIC
      WHEN 'bounced'      THEN g.bounced::NUMERIC
      WHEN 'disconnected' THEN g.disconnected::NUMERIC
      WHEN 'bounce_rate'  THEN CASE WHEN g.sent > 0 THEN g.bounced::NUMERIC / g.sent END
      WHEN 'reply_rate'   THEN CASE WHEN g.sent > 0 THEN g.replied::NUMERIC / g.sent END
    END END) ASC NULLS LAST,
    (CASE WHEN p_dir <> 'asc' THEN CASE p_sort
      WHEN 'sent'         THEN g.sent::NUMERIC
      WHEN 'inboxes'      THEN g.inboxes::NUMERIC
      WHEN 'bounced'      THEN g.bounced::NUMERIC
      WHEN 'disconnected' THEN g.disconnected::NUMERIC
      WHEN 'bounce_rate'  THEN CASE WHEN g.sent > 0 THEN g.bounced::NUMERIC / g.sent END
      WHEN 'reply_rate'   THEN CASE WHEN g.sent > 0 THEN g.replied::NUMERIC / g.sent END
    END END) DESC NULLS LAST,
    (CASE WHEN p_dir = 'asc'  THEN CASE p_sort WHEN 'label' THEN NULLIF(g.label, '') END END) ASC NULLS LAST,
    (CASE WHEN p_dir <> 'asc' THEN CASE p_sort WHEN 'label' THEN NULLIF(g.label, '') END END) DESC NULLS LAST,
    g.sent DESC;
$function$;

-- --------------------------------------------------------------------------
-- The estate summary and the band distribution must not count ghosts either.
-- --------------------------------------------------------------------------

-- The return type gains `disconnected`, so this cannot be a REPLACE.
DROP FUNCTION IF EXISTS analytics_sender_totals(BIGINT);

CREATE FUNCTION public.analytics_sender_totals(p_team_id bigint)
 RETURNS TABLE(inboxes bigint, sending bigint, domains bigint, providers bigint,
               sent bigint, bounced bigint, replied bigint,
               bounce_rate numeric, reply_rate numeric, disconnected bigint)
 LANGUAGE sql STABLE AS $function$
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE COALESCE(s.lifetime_sent, 0) > 0),
    COUNT(DISTINCT s.domain),
    COUNT(DISTINCT s.provider),
    SUM(COALESCE(s.lifetime_sent, 0)),
    SUM(COALESCE(s.lifetime_bounced, 0)),
    SUM(COALESCE(s.unique_replied, 0)),
    CASE WHEN SUM(COALESCE(s.lifetime_sent, 0)) > 0
         THEN SUM(COALESCE(s.lifetime_bounced, 0))::NUMERIC
              / SUM(COALESCE(s.lifetime_sent, 0)) END,
    CASE WHEN SUM(COALESCE(s.lifetime_sent, 0)) > 0
         THEN SUM(COALESCE(s.unique_replied, 0))::NUMERIC
              / SUM(COALESCE(s.lifetime_sent, 0)) END,
    COUNT(*) FILTER (WHERE COALESCE(s.status, '') <> 'Connected')
  FROM sender_emails s
  WHERE s.team_id = p_team_id
    AND s.archived_at IS NULL;
$function$;

CREATE OR REPLACE FUNCTION public.analytics_sender_bands(p_team_id bigint, p_min_sent integer DEFAULT 1)
 RETURNS TABLE(band text, domains bigint, inboxes bigint, sent bigint, bounced bigint)
 LANGUAGE sql STABLE AS $function$
  WITH per_domain AS (
    SELECT
      COALESCE(s.domain, 'unknown')            AS domain,
      COUNT(*)                                 AS inboxes,
      SUM(COALESCE(s.lifetime_sent, 0))        AS sent,
      SUM(COALESCE(s.lifetime_bounced, 0))     AS bounced
    FROM sender_emails s
    WHERE s.team_id = p_team_id
      AND s.archived_at IS NULL
    GROUP BY 1
    -- Domains that have never sent carry no reputation yet and would swamp the
    -- healthy band with meaningless zeros.
    HAVING SUM(COALESCE(s.lifetime_sent, 0)) >= p_min_sent
  )
  SELECT
    CASE
      WHEN d.bounced::NUMERIC / d.sent >= 0.03 THEN 'high'
      WHEN d.bounced::NUMERIC / d.sent >= 0.02 THEN 'watch'
      ELSE 'ok'
    END AS band,
    COUNT(*),
    SUM(d.inboxes),
    SUM(d.sent),
    SUM(d.bounced)
  FROM per_domain d
  GROUP BY 1;
$function$;

-- --------------------------------------------------------------------------
-- The disconnected list.
-- --------------------------------------------------------------------------

/*
 * An inbox that is not Connected is not sending, whatever the campaign thinks.
 *
 * WHY last_sent_at MATTERS MORE THAN THE COUNT. 61 "Not connected" is a number
 * you look at once. "This one was sending 400 a week until Tuesday" is a job.
 * The two cases are opposite and the status alone cannot tell them apart: an
 * inbox that never connected is a setup task, one that stopped is an outage.
 *
 * last_sent_at comes from campaign_lead_sends (422,555 of 433,087 lifetime
 * sends, 97.6%), so it is very nearly complete but not definitionally so —
 * which is why `sent` beside it comes from the inbox's own lifetime counter and
 * is exact. A NULL date next to a non-zero `sent` means "sent before we started
 * recording membership", not "never sent".
 */
CREATE OR REPLACE FUNCTION analytics_disconnected_inboxes(
  p_team_id BIGINT,
  p_limit   INTEGER DEFAULT 200
)
RETURNS TABLE (
  id bigint, email text, domain text, vendor text, provider text, status text,
  sent integer, bounced integer, daily_limit integer, last_sent_at timestamptz
)
LANGUAGE sql STABLE AS $function$
  SELECT
    s.id, s.email, s.domain, s.vendor, s.provider, s.status,
    COALESCE(s.lifetime_sent, 0),
    COALESCE(s.lifetime_bounced, 0),
    s.daily_limit,
    (SELECT MAX(cls.sent_at) FROM campaign_lead_sends cls
      WHERE cls.sender_email_id = s.id)
  FROM sender_emails s
  WHERE s.team_id = p_team_id
    AND s.archived_at IS NULL
    AND COALESCE(s.status, '') <> 'Connected'
  /*
   * Worst first, and "worst" is the one that was doing the most work when it
   * stopped. An inbox that never sent sorts last: it is a setup task, not an
   * outage, and it must not push a live failure off the top of the list.
   */
  ORDER BY COALESCE(s.lifetime_sent, 0) DESC, s.email
  LIMIT p_limit;
$function$;

/*
 * The vendor facet, for the filter control. Read from the data rather than
 * hard-coded, so a vendor added upstream appears without a deploy.
 */
CREATE OR REPLACE FUNCTION analytics_sender_vendors(p_team_id BIGINT)
RETURNS TABLE (vendor TEXT, inboxes BIGINT)
LANGUAGE sql STABLE AS $function$
  SELECT COALESCE(s.vendor, 'untagged'), COUNT(*)
  FROM sender_emails s
  WHERE s.team_id = p_team_id AND s.archived_at IS NULL
  GROUP BY 1
  ORDER BY COUNT(*) DESC;
$function$;

INSERT INTO schema_migrations (version) VALUES ('060_inbox_vendors')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
