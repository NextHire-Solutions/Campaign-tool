-- 069 — who can actually be re-sequenced.
--
-- "Duplicate & re-campaign" moves the people who never answered into a fresh
-- copy of the sequence. The obvious selection — unresponsive ON THIS CAMPAIGN —
-- is wildly optimistic, and I only found out by running it.
--
-- MEASURED ON CAMPAIGN 55. 5,982 leads are unresponsive there. Attaching all
-- 5,982 to a duplicate added 1,076. EmailBison refuses a lead that is currently
-- being emailed by ANOTHER sequence, and one that has bounced or unsubscribed:
--
--   "No leads were added because they are either in other sequences,
--    have previously bounced, or unsubscribed"
--
-- and of those 5,982, FOUR THOUSAND SEVEN HUNDRED AND NINETY-NINE are
-- mid-sequence in a different campaign. These leads sit in several campaigns at
-- once — 5,831 of the 5,982 do — so "finished here" says almost nothing about
-- whether they are free.
--
-- That refusal is correct behaviour, not an obstacle: someone still receiving
-- campaign 94's sequence must not start receiving this one too.
--
-- WHY IT MATTERS THAT THE NUMBER IS RIGHT BEFORE THE CLICK. A dialog offering
-- to move 5,982 leads that moves 1,076 has lied about the size of the thing it
-- just did, and the operator has no way to tell which 1,076. Excluding them
-- here takes the estimate from 5,982 to 1,177 against a true 1,076, and it also
-- stops 4,799 ids being sent to an API that will only refuse them.
--
-- IT IS STILL AN ESTIMATE, DELIBERATELY NOT EXACT. EmailBison's own per-lead
-- state is the authority and reading it costs one call per lead. Our figure is
-- within about 9%, the remainder being leads that bounced or unsubscribed in
-- ways we do not see. So the UI says "up to N" and reports the confirmed count
-- afterwards, which attachLeads measures from the campaign's own total.

BEGIN;

/*
 * Unresponsive on this campaign AND not mid-sequence anywhere.
 *
 * "Mid-sequence" is `step_reached < the campaign's step count` — the same
 * definition behind the `contacted` status the Leads tab shows, applied across
 * every campaign the lead belongs to rather than just this one.
 *
 * Removed leads (065) do not count as mid-sequence: they were taken off that
 * campaign, so it is no longer emailing them.
 */
CREATE OR REPLACE FUNCTION analytics_recampaign_lead_ids(
  p_team_id     BIGINT,
  p_campaign_id BIGINT
)
RETURNS BIGINT[]
LANGUAGE sql STABLE AS $function$
  WITH step_counts AS (
    SELECT ss.campaign_id, COUNT(*)::INTEGER AS steps
    FROM sequence_steps ss
    WHERE NOT ss.is_variant
    GROUP BY 1
  ),
  mid_sequence AS (
    SELECT DISTINCT cl.lead_id
    FROM campaign_leads cl
    JOIN step_counts sc ON sc.campaign_id = cl.campaign_id
    WHERE cl.team_id = p_team_id
      AND cl.removed_at IS NULL
      AND cl.step_reached < sc.steps
  )
  SELECT COALESCE(ARRAY_AGG(x.lead_id ORDER BY x.lead_id), ARRAY[]::BIGINT[])
  FROM (
    SELECT unnest(
      analytics_campaign_lead_ids(p_team_id, p_campaign_id, NULL, ARRAY['completed','contacted'])
    ) AS lead_id
  ) x
  WHERE NOT EXISTS (SELECT 1 FROM mid_sequence m WHERE m.lead_id = x.lead_id);
$function$;

/*
 * The same split, for the dialog: how many are unresponsive, and how many of
 * those are actually free to move. Showing both is what makes the smaller
 * number believable rather than looking like leads went missing.
 */
CREATE OR REPLACE FUNCTION analytics_recampaign_preview(
  p_team_id     BIGINT,
  p_campaign_id BIGINT
)
RETURNS TABLE (unresponsive BIGINT, available BIGINT)
LANGUAGE sql STABLE AS $function$
  SELECT
    COALESCE(array_length(
      analytics_campaign_lead_ids(p_team_id, p_campaign_id, NULL, ARRAY['completed','contacted']), 1), 0),
    COALESCE(array_length(
      analytics_recampaign_lead_ids(p_team_id, p_campaign_id), 1), 0);
$function$;

INSERT INTO schema_migrations (version) VALUES ('069_recampaign_selection')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
