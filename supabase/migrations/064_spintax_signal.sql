-- 064 — which campaigns are sending the same words to everybody.
--
-- Spintax is EmailBison's `{{a | b | c}}`: each send picks one option, so no two
-- recipients get a byte-identical message. Without it a campaign sends one
-- string tens of thousands of times, which is the pattern filters are built to
-- catch. Nothing in the product could see whether a campaign used it.
--
-- ---------------------------------------------------------------------------
-- THE SYNTAX, WHICH I GOT WRONG FIRST TIME AND MEASURED SECOND.
--
-- Spintax is DOUBLE-braced; SINGLE braces are merge variables:
--
--   {{Hi {FIRST_NAME}, | Hello {FIRST_NAME}, | Hey {FIRST_NAME},}}   spintax
--   {FIRST_NAME}                                     471×          variable
--   {{firstName}}                                      6×          variable, no pipe
--
-- So the test is a `{{...}}` block CONTAINING A PIPE. Requiring the pipe is what
-- keeps `{{firstName}}` out. And the options may themselves contain `{VAR}`
-- tokens, so a naive `\{[^{}]*\|[^{}]*\}` cannot cross them and silently misses
-- exactly the well-personalised copy you would least expect to be missed. The
-- pattern below allows one level of nesting for that reason.
--
-- ---------------------------------------------------------------------------
-- THREE STATES, NOT TWO — AND THIS IS THE POINT THAT NEARLY GOT MISSED.
--
-- EmailBison also supports per-step VARIANTS, which vary copy a different way.
-- 20 campaigns use variants and no spintax; flagging on spintax alone would
-- have called all 20 unvaried when they are not. Measured live:
--
--   no variation at all    92 campaigns   259,028 sends   <- the finding
--   has spintax            32 campaigns   128,535 sends
--   variants only          20 campaigns    34,457 sends
--
-- Sixty-one percent of all volume goes through campaigns whose copy never
-- changes. `variants` is reported beside the verdict so the judgement is
-- visible rather than buried in it.
--
-- Scoping copied from analytics_copy_steps exactly — same client filter, same
-- excluded-campaign rule, same date source (campaign_step_stats_daily) — so a
-- campaign counted here is one the Copy tab is already showing.

BEGIN;

CREATE OR REPLACE FUNCTION analytics_spintax_campaigns(
  p_team_id      BIGINT,
  p_from         DATE,
  p_to           DATE,
  p_client_ids   UUID[]   DEFAULT NULL,
  p_campaign_ids BIGINT[] DEFAULT NULL
)
RETURNS TABLE (
  campaign_id   BIGINT,
  campaign_name TEXT,
  client_name   TEXT,
  steps         BIGINT,   -- real steps, excluding variants
  spun_steps    BIGINT,
  variants      BIGINT,
  status        TEXT,     -- spintax | partial | variants | none
  sent          BIGINT
)
LANGUAGE sql STABLE AS $function$
  WITH scoped AS (
    SELECT c.id, c.name, cc.client_id
    FROM campaigns c
    JOIN campaign_clients cc ON cc.campaign_id = c.id
    WHERE c.team_id = p_team_id
      AND c.deleted_at IS NULL
      AND NOT cc.excluded
      AND (p_campaign_ids IS NULL OR c.id = ANY(p_campaign_ids))
      AND (p_client_ids   IS NULL OR cc.client_id = ANY(p_client_ids))
  ),
  copy AS (
    SELECT
      ss.campaign_id,
      COUNT(*) FILTER (WHERE NOT ss.is_variant) AS steps,
      COUNT(*) FILTER (WHERE ss.is_variant)     AS variants,
      /*
       * A `{{...}}` block containing a pipe, where an option may itself hold a
       * {VARIABLE}. Subject and body both, because a repeated subject line is
       * the more visible fingerprint of the two.
       */
      COUNT(*) FILTER (
        WHERE NOT ss.is_variant
          AND (
            ss.email_body    ~ '\{\{(?:[^{}]|\{[^{}]*\})*\|(?:[^{}]|\{[^{}]*\})*\}\}'
            OR ss.email_subject ~ '\{\{(?:[^{}]|\{[^{}]*\})*\|(?:[^{}]|\{[^{}]*\})*\}\}'
          )
      ) AS spun_steps
    FROM sequence_steps ss
    WHERE ss.team_id = p_team_id
      AND ss.campaign_id IN (SELECT id FROM scoped)
    GROUP BY 1
  ),
  volume AS (
    SELECT s.campaign_id, SUM(s.sent) AS sent
    FROM campaign_step_stats_daily s
    WHERE s.team_id = p_team_id
      AND s.stat_date BETWEEN p_from AND p_to
      AND s.campaign_id IN (SELECT id FROM scoped)
    GROUP BY 1
  )
  SELECT
    sc.id,
    sc.name,
    cl.name,
    COALESCE(co.steps, 0),
    COALESCE(co.spun_steps, 0),
    COALESCE(co.variants, 0),
    CASE
      -- No sequence cached yet: silence, not a verdict. A campaign whose copy
      -- we have not synced must not be reported as unspintaxed.
      WHEN COALESCE(co.steps, 0) = 0            THEN 'unknown'
      WHEN co.spun_steps = co.steps             THEN 'spintax'
      WHEN co.spun_steps > 0                    THEN 'partial'
      WHEN COALESCE(co.variants, 0) > 0         THEN 'variants'
      ELSE 'none'
    END,
    COALESCE(v.sent, 0)
  FROM scoped sc
  LEFT JOIN clients cl ON cl.id = sc.client_id
  LEFT JOIN copy   co  ON co.campaign_id = sc.id
  LEFT JOIN volume v   ON v.campaign_id  = sc.id
  /*
   * Worst first, and "worst" is weighted by volume: an unvaried campaign that
   * sent 40,000 emails is a different problem from one that sent 12, and a list
   * ordered by name would bury the first under the second.
   */
  ORDER BY
    CASE
      WHEN COALESCE(co.steps, 0) = 0 THEN 4
      WHEN co.spun_steps = co.steps  THEN 3
      WHEN co.spun_steps > 0         THEN 2
      WHEN COALESCE(co.variants, 0) > 0 THEN 1
      ELSE 0
    END,
    COALESCE(v.sent, 0) DESC,
    sc.name;
$function$;

INSERT INTO schema_migrations (version) VALUES ('064_spintax_signal')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
