-- 065 — record that a lead was removed from a campaign.
--
-- The Leads tab lets you select leads and remove them from the campaign. The
-- removal itself happens in EmailBison (`DELETE /api/campaigns/{id}/leads`);
-- this is the part that keeps our side honest about it.
--
-- ---------------------------------------------------------------------------
-- WHY A MARKER AND NOT A DELETE.
--
-- campaign_leads is DERIVED, entirely, from campaign_lead_sends — see
-- refresh_campaign_leads(). Membership is not stored anywhere; it is inferred
-- from "did this campaign ever send to this lead". So deleting the row does
-- nothing: the next sync recomputes it from send history that still exists, and
-- every removed lead comes back. Someone would remove 500 leads, see them go,
-- and find them all present again three hours later — the feature would look
-- broken while having worked perfectly.
--
-- Deleting the SEND HISTORY instead would fix the display and be much worse: it
-- would silently change the campaign's past — sends, opens, replies and every
-- number in Analytics that reads campaign_lead_sends. Removing a lead stops
-- FUTURE emails; it does not unsend the ones already sent.
--
-- So the send history stays exactly as it is, and the removal is recorded
-- beside it. `removed_at` is deliberately NOT in refresh_campaign_leads's
-- ON CONFLICT update list, so a resync recomputes the stats and leaves the
-- marker alone.
--
-- RE-ADDING MUST CLEAR IT. Duplicate & Re-Campaign attaches leads to a
-- campaign, and a lead removed once and legitimately added back would otherwise
-- stay invisible for ever. The attach path clears removed_at for exactly the
-- ids it attaches.
--
-- REMOVED LEADS ARE HIDDEN, NOT ERASED. The rows stay queryable behind a
-- "Removed" facet, so "what did we take out of this campaign, and when" is
-- answerable. A destructive action you cannot review afterwards is one nobody
-- should be asked to confirm.

BEGIN;

ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS removed_by TEXT;

-- Every read path filters on this, and it is highly selective.
CREATE INDEX IF NOT EXISTS idx_campaign_leads_live
  ON campaign_leads (campaign_id) WHERE removed_at IS NULL;

/*
 * The facets. `removed` is its own bucket rather than a status value: it is
 * orthogonal to bounced/replied/completed (a removed lead was also one of
 * those), and folding it in would silently change what "contacted" counts.
 */
CREATE OR REPLACE FUNCTION public.analytics_campaign_lead_facets(
  p_team_id bigint,
  p_campaign_id bigint
)
RETURNS TABLE(status text, leads bigint)
LANGUAGE sql STABLE AS $function$
  WITH step_count AS (
    SELECT COUNT(*)::INTEGER AS steps FROM sequence_steps ss
     WHERE ss.campaign_id = p_campaign_id AND NOT ss.is_variant
  ),
  live AS (
    SELECT
      CASE
        WHEN rp.bounced  THEN 'bounced'
        WHEN rp.positive THEN 'positive'
        WHEN rp.replied  THEN 'replied'
        WHEN cl.step_reached >= sc.steps THEN 'completed'
        ELSE 'contacted'
      END AS status,
      COUNT(*) AS leads
    FROM campaign_leads cl
    CROSS JOIN step_count sc
    LEFT JOIN LATERAL (
      SELECT
        bool_or(r.is_bounce_notification)                         AS bounced,
        bool_or(r.tracked_reply AND NOT r.is_bounce_notification) AS replied,
        bool_or(r.tracked_reply AND NOT r.is_bounce_notification
                AND r.sentiment = 'positive')                     AS positive
      FROM replies r
      WHERE r.campaign_id = cl.campaign_id AND r.lead_id = cl.lead_id
    ) rp ON TRUE
    WHERE cl.team_id = p_team_id AND cl.campaign_id = p_campaign_id
      AND cl.removed_at IS NULL
    GROUP BY 1
  ),
  removed AS (
    SELECT 'removed'::TEXT AS status, COUNT(*) AS leads
    FROM campaign_leads cl
    WHERE cl.team_id = p_team_id AND cl.campaign_id = p_campaign_id
      AND cl.removed_at IS NOT NULL
    HAVING COUNT(*) > 0
  )
  SELECT * FROM live
  UNION ALL
  SELECT * FROM removed
  ORDER BY 2 DESC;
$function$;

INSERT INTO schema_migrations (version) VALUES ('065_lead_removal')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
