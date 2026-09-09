-- 077 — Instantly's per-day bounces, which closes the last parity gap.
--
-- The day-stats sync was built on /campaigns/analytics/daily, which carries no
-- bounce field at all — so Instantly could report sends and replies for a date
-- range but not bounces, and the KPI band had to show a dash whenever Instantly
-- was in scope.
--
-- It turns out /campaigns/analytics DOES window its figures, bounces included:
--
--   54 Realty (9)    lifetime 43    1-9 Sep 4    1 Aug-9 Sep 19
--
-- and it returns EVERY campaign in one call. So asking it once per DAY gives a
-- complete per-campaign, per-day table with bounces — verified two ways: a
-- single day's sends equal the workspace daily series exactly (942 = 942), and
-- nine daily calls sum to the same bounce total as one nine-day ranged call
-- (11 = 11).
--
-- It is also CHEAPER. One call per day over a 45-day window is 45 requests,
-- against 113 for one per active campaign — and it stops scaling with the
-- number of campaigns, which was the part that would have got worse.
--
-- The extra columns come free with the same response, so the table can answer
-- the same questions the EmailBison one does rather than a subset.

BEGIN;

ALTER TABLE instantly_campaign_day_stats ADD COLUMN IF NOT EXISTS bounced        INTEGER;
ALTER TABLE instantly_campaign_day_stats ADD COLUMN IF NOT EXISTS unsubscribed   INTEGER;
ALTER TABLE instantly_campaign_day_stats ADD COLUMN IF NOT EXISTS leads_count    INTEGER;
ALTER TABLE instantly_campaign_day_stats ADD COLUMN IF NOT EXISTS completed      INTEGER;

/*
 * Nullable, and left NULL by the old rows on purpose. Days written before this
 * migration were fetched from an endpoint that never reported a bounce, so a 0
 * there would assert that nothing bounced that day — a claim the data cannot
 * support. The deep sweep rewrites its window on the next run and fills them in
 * properly; until then a dash is the honest answer (rule 1).
 */

INSERT INTO schema_migrations (version) VALUES ('077_instantly_day_bounces')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
