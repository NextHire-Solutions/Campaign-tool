-- 089 — the un-spintaxed signal, for Instantly's copy as well.
--
-- The Copy & Offer tab read 548 EmailBison steps and ignored 1,376 Instantly
-- ones — 28% coverage of a signal whose entire job is to find copy that never
-- varies. And Instantly is where the finding is: only 6 of its 1,367 steps use
-- spintax at all, against copy that has sent hundreds of thousands of emails.
--
-- THE REGEX IS UNCHANGED, deliberately. 064 matches a `{{…|…}}` block, and
-- Instantly's `{{RANDOM |a|b|c}}` is one — the marker differs but the shape is
-- identical, so the same definition of "this step varies" applies to both. A
-- second pattern would be a second definition, and the two would drift.
--
-- Returned separately rather than unioned into 064, because campaign_id is a
-- BIGINT there and a UUID here. The route concatenates them; widening the
-- existing function's return type would break every caller for no gain.

BEGIN;

CREATE OR REPLACE FUNCTION analytics_instantly_spintax_campaigns(
  p_team_id    BIGINT,
  p_from       DATE,
  p_to         DATE,
  p_client_ids UUID[] DEFAULT NULL
)
RETURNS TABLE (
  campaign_id   TEXT,
  campaign_name TEXT,
  client_name   TEXT,
  steps         BIGINT,
  spun_steps    BIGINT,
  variants      BIGINT,
  status        TEXT,
  sent          BIGINT
)
LANGUAGE sql STABLE AS $function$
  WITH scoped AS (
    SELECT ic.id, ic.name, icc.client_id
    FROM instantly_campaigns ic
    LEFT JOIN instantly_campaign_clients icc ON icc.campaign_id = ic.id
    WHERE ic.team_id = p_team_id
      AND ic.archived_at IS NULL
      AND COALESCE(icc.excluded, FALSE) = FALSE
      AND (p_client_ids IS NULL OR icc.client_id = ANY(p_client_ids))
  ),
  copy AS (
    SELECT
      ss.campaign_id,
      COUNT(*) FILTER (WHERE NOT ss.is_variant) AS steps,
      COUNT(*) FILTER (WHERE ss.is_variant)     AS variants,
      COUNT(*) FILTER (
        WHERE NOT ss.is_variant
          AND (
            ss.email_body    ~ '\{\{(?:[^{}]|\{[^{}]*\})*\|(?:[^{}]|\{[^{}]*\})*\}\}'
            OR ss.email_subject ~ '\{\{(?:[^{}]|\{[^{}]*\})*\|(?:[^{}]|\{[^{}]*\})*\}\}'
          )
      ) AS spun_steps
    FROM instantly_sequence_steps ss
    WHERE ss.team_id = p_team_id
      AND ss.campaign_id IN (SELECT id FROM scoped)
    GROUP BY 1
  ),
  volume AS (
    SELECT d.campaign_id, SUM(d.sent) AS sent
    FROM instantly_campaign_day_stats d
    WHERE d.team_id = p_team_id
      AND d.stat_date BETWEEN p_from AND p_to
      AND d.campaign_id IN (SELECT id FROM scoped)
    GROUP BY 1
  )
  SELECT
    s.id::TEXT,
    s.name,
    cl.name,
    COALESCE(c.steps, 0),
    COALESCE(c.spun_steps, 0),
    COALESCE(c.variants, 0),
    /*
     * The same four states 064 defines, so one legend covers both platforms.
     * `variants` outranks `none`: a campaign with A/B steps is varying its copy
     * by another means, and calling that "none" would send someone to fix
     * something that is not broken.
     */
    CASE
      WHEN COALESCE(c.steps, 0) = 0                    THEN 'none'
      WHEN c.spun_steps = c.steps                      THEN 'spintax'
      WHEN c.spun_steps > 0                            THEN 'partial'
      WHEN COALESCE(c.variants, 0) > 0                 THEN 'variants'
      ELSE 'none'
    END,
    COALESCE(v.sent, 0)::BIGINT
  FROM scoped s
  LEFT JOIN copy c    ON c.campaign_id = s.id
  LEFT JOIN clients cl ON cl.id = s.client_id
  LEFT JOIN volume v  ON v.campaign_id = s.id
  WHERE COALESCE(c.steps, 0) > 0
  ORDER BY COALESCE(v.sent, 0) DESC;
$function$;

INSERT INTO schema_migrations (version) VALUES ('089_instantly_spintax')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
