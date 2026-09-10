-- 083 — let the audit log record an action on either platform.
--
-- `campaign_id` is BIGINT NOT NULL, which no Instantly campaign can satisfy:
-- its ids are uuids. Bulk actions are about to dispatch by platform, and an
-- audit row that cannot be written is the worst possible failure mode here —
-- the action still happens on the sending platform, and the only record that it
-- happened is the one that just threw.
--
-- The existing column is KEPT and kept meaning what it meant. Every query,
-- index and report that reads `campaign_id` as an EmailBison id continues to;
-- it simply goes NULL for Instantly rows, which is honest — there is no
-- EmailBison campaign to name. `campaign_ref` is the id as text for either
-- platform, and `platform` says which namespace to read it in. An id without
-- its platform is ambiguous, so they are added together.

BEGIN;

ALTER TABLE campaign_audit_log
  ALTER COLUMN campaign_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'emailbison',
  ADD COLUMN IF NOT EXISTS campaign_ref TEXT;

-- Backfill: every row so far is EmailBison, and the default above already says
-- so. This makes `campaign_ref` complete from the start, so a reader never has
-- to fall back to campaign_id for older rows.
UPDATE campaign_audit_log
   SET campaign_ref = campaign_id::TEXT
 WHERE campaign_ref IS NULL AND campaign_id IS NOT NULL;

/*
 * One row per campaign, whichever platform it is on — the index the history
 * view actually needs now that "this campaign's history" can mean either
 * namespace.
 */
CREATE INDEX IF NOT EXISTS idx_cal_campaign_ref
  ON campaign_audit_log (platform, campaign_ref, created_at DESC);

/*
 * A row must identify its campaign SOMEHOW. Without this, a bug that forgot to
 * set either column would write rows that are permanently unattributable, and
 * the failure would be silent because inserts would keep succeeding.
 */
ALTER TABLE campaign_audit_log
  DROP CONSTRAINT IF EXISTS campaign_audit_log_identifies_campaign;
ALTER TABLE campaign_audit_log
  ADD CONSTRAINT campaign_audit_log_identifies_campaign
  CHECK (campaign_id IS NOT NULL OR campaign_ref IS NOT NULL);

INSERT INTO schema_migrations (version) VALUES ('083_audit_both_platforms')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
