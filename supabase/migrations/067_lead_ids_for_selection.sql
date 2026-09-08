-- 067 — the ids behind the current Leads filter, for "select all".
--
-- The Leads tab lets you select leads and remove them from the campaign, and
-- the selection people actually want is "every lead matching this filter", not
-- "the 50 on this page". Campaign 55 has 6,288 leads; removing the unresponsive
-- ones fifty at a time is not a workflow.
--
-- WHY NOT JUST ASK THE ROWS FUNCTION FOR 20,000 ROWS. Because of what that
-- function is built to avoid. It cuts the page FIRST and decorates second — the
-- reply probe, the custom-variable rollup and the sender lookup all run only on
-- the rows being shown, which is what took the Leads tab from 209ms to 35ms
-- (056). Raising p_limit to cover the whole campaign would run every one of
-- those joins over 6,288 rows to return a list of integers.
--
-- IT RETURNS ONE ROW HOLDING AN ARRAY, NOT A ROW PER ID, AND THAT IS THE WHOLE
-- POINT OF THE SIGNATURE. PostgREST caps a result set at 1,000 rows and
-- truncates in silence (CLAUDE.md rule 7). The first version of this returned
-- SETOF BIGINT and duly handed back 1,000 of campaign 55's 6,288 ids — so
-- "select all 6,288" would have selected 1,000, the dialog would have said
-- 6,288, and the removal would have taken a different set from the one it
-- named. On a destructive action that is the worst shape a bug can have: it
-- reports success, and what it did is invisible.
--
-- One row carrying an array is not subject to the row cap.
--
-- THE FILTER LOGIC IS COPIED VERBATIM from the live definition of
-- analytics_campaign_lead_rows, generated rather than retyped. If this function
-- and that one ever disagreed about what "matches", the screen would say 4,000
-- leads and the removal would take a different 4,000 — with a confirmation
-- dialog in between stating a number that was true of neither.

BEGIN;

CREATE OR REPLACE FUNCTION analytics_campaign_lead_ids(
  p_team_id     BIGINT,
  p_campaign_id BIGINT,
  p_search      TEXT     DEFAULT NULL,
  p_status      TEXT[]   DEFAULT NULL
)
RETURNS BIGINT[]
LANGUAGE sql STABLE AS $function$
  SELECT COALESCE(ARRAY_AGG(x.lead_id), ARRAY[]::BIGINT[]) FROM (
  WITH step_count AS (
    -- Once, not once per row.
    SELECT COUNT(*)::INTEGER AS steps FROM sequence_steps ss
     WHERE ss.campaign_id = p_campaign_id AND NOT ss.is_variant
  ),
  scoped AS (
    /*
     * Ids and sort keys only. Every join that costs anything — the reply probe,
     * the attribute rollup, the sender lookup — happens after the page is cut.
     */
    SELECT
      cl.lead_id,
      cl.step_reached, cl.sends, cl.first_sent_at, cl.last_sent_at,
      cl.opens, cl.unique_opens, cl.clicks,
      l.email, l.first_name, l.last_name, l.company, l.title,
      CASE
        WHEN rp.bounced  THEN 'bounced'
        WHEN rp.positive THEN 'positive'
        WHEN rp.replied  THEN 'replied'
        WHEN cl.step_reached >= sc.steps THEN 'completed'
        ELSE 'contacted'
      END AS derived_status,
      rp.replies, rp.positives, rp.bounces
    FROM campaign_leads cl
    LEFT JOIN leads l ON l.id = cl.lead_id
    CROSS JOIN step_count sc
    /*
     * ONE index scan per lead, not three.
     *
     * This was three correlated EXISTS — bounced, positive, replied — each
     * probing `replies` for every lead in the campaign before the page was cut:
     * 7,302 probes to render 50 rows on a 2,434-lead campaign. Same shape as the
     * bug 029 fixed. One LATERAL aggregates all of it in a single pass, and it
     * returns the counts too, so the outer query no longer needs its own three
     * subqueries either.
     */
    LEFT JOIN LATERAL (
      SELECT
        bool_or(r.is_bounce_notification)                                  AS bounced,
        bool_or(r.tracked_reply AND NOT r.is_bounce_notification)          AS replied,
        bool_or(r.tracked_reply AND NOT r.is_bounce_notification
                AND r.sentiment = 'positive')                              AS positive,
        COUNT(*) FILTER (WHERE r.tracked_reply AND NOT r.is_bounce_notification) AS replies,
        COUNT(*) FILTER (WHERE r.tracked_reply AND NOT r.is_bounce_notification
                           AND r.sentiment = 'positive')                   AS positives,
        COUNT(*) FILTER (WHERE r.is_bounce_notification)                   AS bounces
      FROM replies r
      WHERE r.campaign_id = cl.campaign_id AND r.lead_id = cl.lead_id
    ) rp ON TRUE
    WHERE cl.team_id = p_team_id
      AND cl.campaign_id = p_campaign_id
      /*
       * Removed leads are hidden by default and reachable only by asking for
       * them, which is why this reads the status array rather than a separate
       * flag: 'removed' is a choice in the same control as every other filter.
       */
      AND (
        CASE WHEN 'removed' = ANY(COALESCE(p_status, ARRAY[]::TEXT[]))
             THEN cl.removed_at IS NOT NULL
             ELSE cl.removed_at IS NULL END
      )
      AND (
        p_search IS NULL
        OR l.email      ILIKE '%' || p_search || '%'
        OR l.first_name ILIKE '%' || p_search || '%'
        OR l.last_name  ILIKE '%' || p_search || '%'
        OR l.company    ILIKE '%' || p_search || '%'
      )
  ),
  filtered AS (
    SELECT * FROM scoped
     WHERE p_status IS NULL
        OR p_status = ARRAY['removed']::TEXT[]
        OR derived_status = ANY(p_status)
  )
  SELECT f.lead_id FROM filtered f
  ) x;
$function$;

INSERT INTO schema_migrations (version) VALUES ('067_lead_ids_for_selection')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
