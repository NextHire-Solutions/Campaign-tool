-- 075 — how many bounced leads a campaign is still carrying.
--
-- Client feedback: "Can we also remove leads who bounced when we re-campaign?"
--
-- They are right that it is worth doing. Across the workspace 5,861 bounced
-- leads are still attached to 135 campaigns — mailboxes that have already
-- refused delivery and will refuse it again on every remaining step, spending
-- sending reputation to do it.
--
-- The preview gains the count so the dialog can state it before the click,
-- rather than offering a cleanup whose size nobody knows.

BEGIN;

DROP FUNCTION IF EXISTS analytics_recampaign_preview(BIGINT, BIGINT);

CREATE FUNCTION analytics_recampaign_preview(
  p_team_id     BIGINT,
  p_campaign_id BIGINT
)
RETURNS TABLE (unresponsive BIGINT, available BIGINT, bounced BIGINT)
LANGUAGE sql STABLE AS $function$
  SELECT
    COALESCE(array_length(
      analytics_campaign_lead_ids(p_team_id, p_campaign_id, NULL, ARRAY['completed','contacted']), 1), 0),
    COALESCE(array_length(
      analytics_recampaign_lead_ids(p_team_id, p_campaign_id), 1), 0),
    /*
     * Bounced leads still attached to THIS campaign. Counted from the same
     * derived status the Leads tab shows, so the number in the dialog and the
     * number on the tab cannot disagree — and since 072 that status finally
     * sees every bounced lead, not the 9% that kept a send row.
     */
    COALESCE(array_length(
      analytics_campaign_lead_ids(p_team_id, p_campaign_id, NULL, ARRAY['bounced']), 1), 0);
$function$;

INSERT INTO schema_migrations (version) VALUES ('075_recampaign_bounced')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
