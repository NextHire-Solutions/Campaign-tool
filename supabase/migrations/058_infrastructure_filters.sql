-- 058 — filters on all three Infrastructure views.
--
-- Sorting and search landed in 052 and 057; this is the third leg. The screen
-- could show you 503 domains in any order and let you find one by name, but not
-- ask a question of them.
--
-- WHY THESE FOUR, and not an arbitrary set. Measured against the live estate:
--
--   MINIMUM VOLUME is the one that matters most. The bands count any domain
--   with a single send, so 254 domains currently read Critical -- and every one
--   of them has sent under 50 emails. Apply a 50-send floor and Critical goes to
--   ZERO. There is no established domain above 3%. That distinction is invisible
--   today and it is the difference between "254 domains on fire" and "nothing is
--   wrong". For the rollups this has to be the DOMAIN's total, not each inbox's,
--   which is why it is a HAVING and not a WHERE.
--
--   BAND turns the summary card into something you can act on. It already says
--   208 healthy / 9 watch / 254 critical; clicking through to see which ones was
--   not possible.
--
--   PROVIDER (1,168 Google Workspace, 336 custom) and STATUS (1,440 connected,
--   61 not connected, 3 failed) are the two other real splits in the data.
--
-- Deliberately NOT a filter: warmup_enabled. It is true for 1,501 of 1,504
-- inboxes, so it separates nothing.
--
-- An inbox or domain that has never sent is in NO band. It has no bounce rate,
-- only the absence of one, and filing silence under "healthy" would be a claim
-- the data does not support. It gets its own 'unsent' value so it is still
-- reachable -- 668 inboxes have never sent, and finding them is a real question.

BEGIN;

DROP FUNCTION IF EXISTS analytics_sender_rows(BIGINT, INTEGER, TEXT, TEXT, INTEGER, INTEGER, TEXT);

CREATE OR REPLACE FUNCTION public.analytics_sender_rows(p_team_id bigint, p_min_sent integer DEFAULT 0, p_search text DEFAULT NULL::text, p_sort text DEFAULT 'sent'::text, p_limit integer DEFAULT 200, p_offset integer DEFAULT 0, p_dir text DEFAULT 'desc'::text, p_bands text[] DEFAULT NULL::text[], p_providers text[] DEFAULT NULL::text[], p_statuses text[] DEFAULT NULL::text[])
 RETURNS TABLE(id bigint, email text, name text, domain text, provider text, status text, daily_limit integer, sent integer, bounced integer, replied integer, bounce_rate numeric, reply_rate numeric, total_count bigint)
 LANGUAGE sql
 STABLE
AS $function$
  WITH filtered AS (
    SELECT s.*
    FROM sender_emails s
    WHERE s.team_id = p_team_id
      AND COALESCE(s.lifetime_sent, 0) >= p_min_sent
      AND (p_search IS NULL OR s.email ILIKE '%' || p_search || '%'
                            OR COALESCE(s.domain, '') ILIKE '%' || p_search || '%')
      AND (p_providers IS NULL OR COALESCE(s.provider, 'unknown') = ANY(p_providers))
      AND (p_statuses  IS NULL OR COALESCE(s.status,   'unknown') = ANY(p_statuses))
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
    f.id, f.email, f.name, f.domain, f.provider, f.status, f.daily_limit,
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
    END END) ASC NULLS LAST,
    (CASE WHEN p_dir <> 'asc' THEN CASE p_sort
      WHEN 'email' THEN NULLIF(f.email, '')
      WHEN 'domain' THEN NULLIF(f.domain, '')
      WHEN 'provider' THEN NULLIF(f.provider, '')
      WHEN 'status' THEN NULLIF(f.status, '')
    END END) DESC NULLS LAST,
    COALESCE(f.lifetime_sent, 0) DESC, f.id
  LIMIT p_limit OFFSET p_offset;
$function$

;

DROP FUNCTION IF EXISTS analytics_sender_groups(BIGINT, TEXT, INTEGER, TEXT, TEXT, TEXT);

CREATE FUNCTION analytics_sender_groups(
  p_team_id   BIGINT,
  p_group     TEXT    DEFAULT 'domain',
  p_min_sent  INTEGER DEFAULT 0,
  p_sort      TEXT    DEFAULT NULL,
  p_dir       TEXT    DEFAULT 'desc',
  p_search    TEXT    DEFAULT NULL,
  p_bands     TEXT[]  DEFAULT NULL,
  p_providers TEXT[]  DEFAULT NULL,
  p_statuses  TEXT[]  DEFAULT NULL,
  p_min_total INTEGER DEFAULT 0
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
      COUNT(*)                             AS inboxes,
      SUM(COALESCE(s.lifetime_sent, 0))    AS sent,
      SUM(COALESCE(s.lifetime_bounced, 0)) AS bounced,
      SUM(COALESCE(s.unique_replied, 0))   AS replied
    FROM sender_emails s
    WHERE s.team_id = p_team_id
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
      )
      AND (p_providers IS NULL OR COALESCE(s.provider, 'unknown') = ANY(p_providers))
      AND (p_statuses  IS NULL OR COALESCE(s.status,   'unknown') = ANY(p_statuses))
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
    CASE WHEN g.sent > 0 THEN g.replied::NUMERIC / g.sent END
  FROM grouped g
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

INSERT INTO schema_migrations (version) VALUES ('058_infrastructure_filters')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
