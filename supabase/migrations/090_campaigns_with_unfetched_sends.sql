-- 090 — never skip a campaign that has sends we have not fetched.
--
-- WHAT HAPPENED. A campaign created and launched the same day showed ONE lead
-- on its Leads tab while EmailBison reported 3,155 leads and 267 sends. Not a
-- bug in the ingest — the sends walk simply had not covered it yet, and it
-- self-heals on the next run. But "self-heals in a few hours" is invisible to
-- whoever is looking at the screen now, and a brand-new campaign is exactly
-- when someone looks.
--
-- WHY IT WAS SKIPPED. The sends job skips campaigns that were quiet in the
-- window, and it decides that from campaign_day_stats — which is written by a
-- DIFFERENT job on its own 3-hourly cadence. So a campaign that starts sending
-- is invisible to the sends job until day-stats notices it first. Two 3-hourly
-- jobs in sequence is a window of up to ~6 hours where a live campaign looks
-- empty, and the skip is silent.
--
-- THE FIX IS A SECOND, INDEPENDENT REASON TO INCLUDE A CAMPAIGN: EmailBison
-- says it has sent more than we hold. That needs no other job to have run, it
-- is exactly the definition of "there is work to do", and it costs one grouped
-- query. The day-stats gate keeps its value — it still spares us ~85 pointless
-- cursor opens per run — but it is no longer the only way in.

BEGIN;

/*
 * Campaigns whose stored send count is behind EmailBison's own counter.
 *
 * `lifetime_emails_sent` is EmailBison's number and moves the moment a campaign
 * sends; our count only moves when this job runs. A gap between them is a
 * campaign with unfetched history, whatever day-stats happens to know.
 *
 * Deleted campaigns are excluded — there is nothing to fetch and nothing that
 * would read it.
 */
CREATE OR REPLACE FUNCTION campaigns_with_unfetched_sends(p_team_id BIGINT)
RETURNS TABLE (campaign_id BIGINT, upstream_sent INTEGER, stored_sends BIGINT)
LANGUAGE sql STABLE AS $function$
  SELECT
    c.id,
    c.lifetime_emails_sent,
    COALESCE(s.n, 0)
  FROM campaigns c
  LEFT JOIN (
    SELECT campaign_id, COUNT(*) AS n
    FROM campaign_lead_sends
    WHERE team_id = p_team_id
    GROUP BY campaign_id
  ) s ON s.campaign_id = c.id
  WHERE c.team_id = p_team_id
    AND c.deleted_at IS NULL
    AND COALESCE(c.lifetime_emails_sent, 0) > COALESCE(s.n, 0);
$function$;

INSERT INTO schema_migrations (version) VALUES ('090_campaigns_with_unfetched_sends')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
