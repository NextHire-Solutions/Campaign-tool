-- 087 — Instantly's sequence steps, so its campaigns get a Sequence tab.
--
-- The detail page hid Sequence, Copy & Offer and Settings for Instantly on the
-- grounds that we did not sync its sequence bodies. That was true and it was
-- the wrong answer: the API returns the whole sequence on the campaign object
-- (`sequences[0].steps[]`, each step carrying `variants[]` of subject + body),
-- so the tabs were hidden for a gap that only existed because nothing had
-- fetched it yet.
--
-- SHAPED LIKE sequence_steps, NOT LIKE INSTANTLY. The Sequence tab, the spintax
-- signal and Copy & Offer all read EmailBison's shape; giving Instantly its own
-- would mean a second renderer for the same idea. So a step is a row, a variant
-- is a row flagged `is_variant` pointing at its parent — exactly how 003 models
-- EmailBison's A/B variants.
--
-- TWO DIFFERENCES ARE REAL AND KEPT:
--   * Instantly has no per-step id of its own. The key is (campaign, step
--     index, variant index), which is stable for as long as the sequence is not
--     reordered — and a reorder rewrites the whole sequence anyway, since the
--     sync replaces every row for a campaign each run.
--   * Delay is per step in `delay` + `delay_unit`, against EmailBison's
--     `wait_in_days`. Normalised to days on write so one column means one thing.

BEGIN;

CREATE TABLE IF NOT EXISTS instantly_sequence_steps (
  campaign_id     UUID NOT NULL,
  team_id         BIGINT NOT NULL,
  step_order      INTEGER NOT NULL,
  variant_index   INTEGER NOT NULL DEFAULT 0,
  is_variant      BOOLEAN NOT NULL DEFAULT FALSE,
  email_subject   TEXT,
  email_body      TEXT,
  wait_in_days    INTEGER,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, step_order, variant_index)
);

CREATE INDEX IF NOT EXISTS idx_inst_steps_campaign
  ON instantly_sequence_steps (team_id, campaign_id, step_order, variant_index);

/*
 * The sequence, in the shape the Sequence tab already renders.
 *
 * `id` is synthesised from the position because Instantly has none. It is
 * stable within a sync and is never sent back to Instantly — writes address a
 * step by its position, which is what the API itself uses.
 */
CREATE OR REPLACE FUNCTION analytics_instantly_sequence(
  p_team_id     BIGINT,
  p_campaign_id UUID
)
RETURNS TABLE (
  id                    BIGINT,
  step_order            INTEGER,
  email_subject         TEXT,
  email_body            TEXT,
  wait_in_days          INTEGER,
  is_variant            BOOLEAN,
  variant_from_step_id  BIGINT
)
LANGUAGE sql STABLE AS $function$
  SELECT
    (s.step_order * 1000 + s.variant_index)::BIGINT AS id,
    s.step_order,
    s.email_subject,
    s.email_body,
    s.wait_in_days,
    s.is_variant,
    CASE WHEN s.is_variant THEN (s.step_order * 1000)::BIGINT ELSE NULL END
  FROM instantly_sequence_steps s
  WHERE s.team_id = p_team_id AND s.campaign_id = p_campaign_id
  ORDER BY s.step_order, s.variant_index;
$function$;

INSERT INTO schema_migrations (version) VALUES ('087_instantly_sequences')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
