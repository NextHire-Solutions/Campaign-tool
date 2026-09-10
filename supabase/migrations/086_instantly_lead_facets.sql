-- 086 — count the Leads-tab facets in SQL, not in JS over a capped result.
--
-- The first version of the Instantly branch asked analytics_instantly_lead_rows
-- for every row (p_limit 2147483647) and tallied the statuses in JS. PostgREST
-- caps an RPC result at 1,000 rows and says nothing, so a campaign of 12,080
-- leads reported "replied 40, contacted 960" — a facet bar that adds up to
-- exactly 1,000 beside a total of 12,080.
--
-- That is CLAUDE.md rule 7, and it is the third time this codebase has been
-- caught by it. The tell is always the same: a number that is suspiciously
-- round, or two numbers on one screen that cannot both be true.
--
-- Counting in SQL also makes the facets agree with the rows by construction —
-- they share the same derivation rather than restating it.

BEGIN;

CREATE OR REPLACE FUNCTION analytics_instantly_lead_facets(
  p_team_id     BIGINT,
  p_campaign_id UUID
)
RETURNS TABLE (status TEXT, leads BIGINT)
LANGUAGE sql STABLE AS $function$
  SELECT
    CASE
      WHEN l.email_reply_count > 0       THEN 'replied'
      WHEN l.last_contact_at IS NOT NULL THEN 'contacted'
      ELSE 'not contacted'
    END AS status,
    COUNT(*)::BIGINT
  FROM instantly_leads l
  WHERE l.team_id = p_team_id
    AND l.campaign_id = p_campaign_id
  GROUP BY 1
  ORDER BY 2 DESC;
$function$;

INSERT INTO schema_migrations (version) VALUES ('086_instantly_lead_facets')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
