-- 068 — inbox pools by tag, counted and listed in SQL.
--
-- Assigning inboxes to campaigns by tag ("Nicole Pool → Client A's campaigns")
-- needs two things: the list of tags with their sizes, and the ids behind one
-- tag. Both were first written as PostgREST `.select()` calls over
-- sender_emails, and both were wrong the moment they ran.
--
-- THE 1,000-ROW CAP, TWICE IN ONE FEATURE. sender_emails holds 1,496 rows and
-- PostgREST truncates a select at 1,000 in silence (CLAUDE.md rule 7). The tag
-- list came back reporting "Nicole Pool: 269 inboxes" against a true 534, and
-- "Google: 954" against 1,427 — numbers low enough to look plausible and high
-- enough to be believed. The id lookup had the same ceiling, so assigning a
-- pool larger than 1,000 would have attached exactly 1,000 inboxes and reported
-- success.
--
-- sender_ids_by_tag returns ONE ROW HOLDING AN ARRAY for that reason: a row per
-- id is subject to the same cap that caused the bug.
--
-- `tags @> ARRAY[tag]` is containment over the whole element, not a substring
-- match. That distinction is load-bearing here: "Nicole Pool" and
-- "Nicole Pool 2" are different pools of 534 and 316 inboxes, and a LIKE would
-- silently merge them.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_sender_emails_tags
  ON sender_emails USING GIN (tags);

/*
 * Every tag on the estate, with how many inboxes carry it and how many of those
 * can actually send. Both numbers are shown because they answer different
 * questions: the first is the pool you bought, the second is the pool you have.
 */
CREATE OR REPLACE FUNCTION analytics_inbox_tags(p_team_id BIGINT)
RETURNS TABLE (tag TEXT, inboxes BIGINT, connected BIGINT)
LANGUAGE sql STABLE AS $function$
  SELECT
    t.tag,
    COUNT(*),
    COUNT(*) FILTER (WHERE s.status = 'Connected')
  FROM sender_emails s
  CROSS JOIN LATERAL unnest(COALESCE(s.tags, ARRAY[]::TEXT[])) AS t(tag)
  WHERE s.team_id = p_team_id
    AND s.archived_at IS NULL
  GROUP BY t.tag
  ORDER BY COUNT(*) DESC;
$function$;

/*
 * The inbox ids behind one tag.
 *
 * `p_connected_only` is the caller's choice because the two directions want
 * opposite answers: attaching a disconnected inbox adds a name to a campaign
 * that will never carry a message, while removing one is exactly the cleanup
 * you would want to do.
 */
CREATE OR REPLACE FUNCTION sender_ids_by_tag(
  p_team_id        BIGINT,
  p_tag            TEXT,
  p_connected_only BOOLEAN DEFAULT TRUE
)
RETURNS BIGINT[]
LANGUAGE sql STABLE AS $function$
  SELECT COALESCE(ARRAY_AGG(s.id ORDER BY s.id), ARRAY[]::BIGINT[])
  FROM sender_emails s
  WHERE s.team_id = p_team_id
    AND s.archived_at IS NULL
    AND s.tags @> ARRAY[p_tag]
    AND (NOT p_connected_only OR s.status = 'Connected');
$function$;

INSERT INTO schema_migrations (version) VALUES ('068_inbox_tags')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
