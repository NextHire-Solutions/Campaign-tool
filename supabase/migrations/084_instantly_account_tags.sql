-- 084 — Instantly's account tags, so "assign a pool" means the same thing on
-- both platforms.
--
-- Inbox assignment on EmailBison is "attach every inbox carrying this tag".
-- That looked unportable: instantly_accounts has no tags column and the
-- accounts endpoint returns none. But Instantly does have them — in a separate
-- custom-tags resource, joined through custom-tag-mappings — and they are the
-- SAME POOLS by name:
--
--     LeadGenJay   500 accounts
--     Nicole Pool  431
--     Howe Realty   48
--
-- So the feature ports exactly, and the only thing that was missing was the
-- sync. Assignment by domain, which was the fallback plan, would have been a
-- second vocabulary for the same idea.
--
-- TEXT[] mirrors what sender_emails already does, so `analytics_inbox_tags` and
-- `sender_ids_by_tag` gain an Instantly twin with the same shape rather than a
-- different one. A GIN index because every read is containment.

BEGIN;

ALTER TABLE instantly_accounts
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_inst_accounts_tags
  ON instantly_accounts USING GIN (tags);

/*
 * The pools on offer, and how much of each is usable.
 *
 * `connected` counts what can actually send. Instantly reports every account as
 * status 2 while the workspace is demonstrably sending (see
 * docs/instantly-api-findings.md), so its status cannot be used to call an
 * inbox dead — every tagged account counts as connected here rather than
 * inventing a distinction the data cannot support. That is why this returns the
 * same shape as analytics_inbox_tags but not the same certainty, and the UI
 * says so.
 */
CREATE OR REPLACE FUNCTION analytics_instantly_inbox_tags(p_team_id BIGINT)
RETURNS TABLE (tag TEXT, inboxes BIGINT, connected BIGINT)
LANGUAGE sql STABLE AS $function$
  SELECT t.tag, COUNT(*)::BIGINT, COUNT(*)::BIGINT
  FROM instantly_accounts a
  CROSS JOIN LATERAL UNNEST(a.tags) AS t(tag)
  WHERE a.team_id = p_team_id AND a.archived_at IS NULL
  GROUP BY t.tag
  ORDER BY 2 DESC;
$function$;

/*
 * The addresses in a pool. Returned as ONE ROW HOLDING AN ARRAY, like
 * sender_ids_by_tag — a plain select would be silently capped at 1,000 by
 * PostgREST (rule 7), and the largest pool here is 500 today with no reason it
 * cannot pass 1,000.
 *
 * Containment over the whole element: "Nicole Pool" must never match a
 * hypothetical "Nicole Pool 2".
 */
CREATE OR REPLACE FUNCTION instantly_account_emails_by_tag(
  p_team_id BIGINT,
  p_tag     TEXT
)
RETURNS TEXT[]
LANGUAGE sql STABLE AS $function$
  SELECT COALESCE(ARRAY_AGG(a.email ORDER BY a.email), '{}')
  FROM instantly_accounts a
  WHERE a.team_id = p_team_id
    AND a.archived_at IS NULL
    AND a.tags @> ARRAY[p_tag];
$function$;

INSERT INTO schema_migrations (version) VALUES ('084_instantly_account_tags')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
