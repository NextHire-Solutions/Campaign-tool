-- 071 — store the field the reply watermark actually filters on.
--
-- The incremental reply sync pages /emails with `min_timestamp_created`, but
-- the watermark was read from `received_at`, which this app sets from
-- `timestamp_email` when present. Those are two different clocks: one is when
-- Instantly created the record, the other is when the message was sent.
--
-- Measured on the newest 100 replies they agree to within three minutes and
-- nothing was being missed. That is luck, not a guarantee — a message written
-- to Instantly appreciably after its own send time would sit before the
-- watermark while being new, and the incremental run would step straight over
-- it. A watermark must be read from the same field it is compared against.
--
-- received_at stays as the reporting date, because "when did this reply happen"
-- is the question every chart asks. created_at is bookkeeping.

BEGIN;

ALTER TABLE instantly_replies ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

-- The watermark read is `ORDER BY created_at DESC LIMIT 1`, on every run.
CREATE INDEX IF NOT EXISTS idx_inst_replies_created
  ON instantly_replies (team_id, created_at DESC);

INSERT INTO schema_migrations (version) VALUES ('071_instantly_reply_watermark')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
