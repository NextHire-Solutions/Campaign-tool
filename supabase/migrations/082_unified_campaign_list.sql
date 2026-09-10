-- 082 — one list containing both platforms' campaigns.
--
-- The Campaigns page shows 184 EmailBison campaigns while the business also
-- runs 318 on Instantly. Those 318 were not merely unfiltered — they were
-- absent, because the route reads the `campaigns` table directly.
--
-- A VIEW rather than a union in the route, and that is the whole point. The
-- page filters by status, search, client and tag, counts exactly, and paginates
-- — all in SQL (081 moved the last of it there after a JS filter was found
-- disagreeing with its own count). Unioning in JS would undo that: the filters
-- would run after paging again, and `total` would go back to describing a
-- different set than the rows.
--
-- STATUS IS TRANSLATED, NOT PASSED THROUGH. Instantly reports an integer and
-- EmailBison a word, and the page has one status vocabulary with one set of
-- colours and one rule about which actions each state allows. Two vocabularies
-- in one table would mean a "2" chip beside a "paused" chip meaning the same
-- thing. Instantly's negative codes are error states with no EmailBison
-- equivalent, so they become 'error' rather than being forced into a familiar
-- word — a status invented at render time is worse than one that needs looking
-- up.
--
-- The id is TEXT because the two platforms key differently: bigint and uuid.
-- Callers must carry `platform` alongside it; an id alone is ambiguous.

BEGIN;

CREATE OR REPLACE VIEW campaigns_unified AS
  SELECT
    c.id::TEXT                          AS id,
    'emailbison'::TEXT                  AS platform,
    c.team_id,
    c.name,
    c.status,
    c.tags,
    c.total_leads,
    c.lifetime_emails_sent,
    c.lifetime_unique_replies,
    c.completion_percentage,
    c.max_emails_per_day,
    c.eb_created_at                     AS created_at,
    c.eb_updated_at                     AS updated_at,
    m.client_id,
    COALESCE(m.excluded, FALSE)         AS excluded,
    COALESCE(m.ambiguous, FALSE)        AS ambiguous
  FROM campaigns c
  LEFT JOIN campaign_clients m ON m.campaign_id = c.id
  WHERE c.deleted_at IS NULL

  UNION ALL

  SELECT
    ic.id::TEXT,
    'instantly'::TEXT,
    ic.team_id,
    ic.name,
    CASE ic.status
      WHEN 0 THEN 'draft'
      WHEN 1 THEN 'active'
      WHEN 2 THEN 'paused'
      WHEN 3 THEN 'completed'
      /*
       * Negative codes are Instantly's error states (-1 suspended, -2 bounce
       * protect, and others). They have no EmailBison counterpart, so they get
       * their own word instead of being flattened into 'paused' — which would
       * read as "someone paused this" rather than "this stopped itself".
       */
      ELSE 'error'
    END,
    /*
     * Instantly has campaign tags, but through a separate custom-tags resource
     * that is not synced. An empty array is honest; inventing tags here would
     * make the tag filter silently exclude every Instantly campaign while
     * appearing to consider them.
     */
    '[]'::JSONB,
    ic.leads_count,
    ic.emails_sent,
    ic.reply_count_unique,
    NULL::NUMERIC,
    NULL::INTEGER,
    ic.eb_created_at,
    -- Instantly reports no per-campaign updated_at; NULL renders as a dash
    -- rather than pretending the create time was an edit.
    NULL::TIMESTAMPTZ,
    im.client_id,
    COALESCE(im.excluded, FALSE),
    COALESCE(im.ambiguous, FALSE)
  FROM instantly_campaigns ic
  LEFT JOIN instantly_campaign_clients im ON im.campaign_id = ic.id
  WHERE ic.archived_at IS NULL;

INSERT INTO schema_migrations (version) VALUES ('082_unified_campaign_list')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
