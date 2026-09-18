-- 091 — Prospects, counted once per lead, and filtered like everything else.
--
-- WHAT WAS WRONG. The Prospects tile did not come from this database at all.
-- It asked EmailBison's workspace stats endpoint for a number. EmailBison has
-- no concept of a client — that mapping exists only here, in campaign_clients,
-- built by matching campaign names to client names — so the only question that
-- endpoint can answer is "how many across the whole workspace".
--
-- The result: Prospects ignored the client filter completely. A screen filtered
-- to one client showed 94.3K, which was everybody's number. It read the same
-- with one client selected, with none selected, and with any platform picked.
-- A client asked why their dashboard showed 94.3K prospects next to 0 sent,
-- which is the question that found this.
--
-- WHY NOT JUST USE analytics_kpis.prospects. Because it sums a DAILY distinct
-- count, so a lead emailed on twenty days counts twenty times. Measured on The
-- Keyes Company for Aug 17 - Sep 15: that column reports 23,329 against 334
-- leads actually contacted. Seventy times too high. Swapping one wrong number
-- for another is not a fix.
--
-- WHAT THIS DOES. Counts each lead once across the whole window, from the send
-- history we already store per lead, honouring the campaign filter and the
-- client filter the same way every other figure on the page does.
--
-- INSTANTLY IS NOT INCLUDED HERE, deliberately. Its prospects come from
-- analytics_instantly_kpis, which reads `new_leads_contacted` — already one
-- row per lead at first contact, so it does not have this fault. The caller
-- adds the two. Instantly stores no per-send history, so a distinct count over
-- an arbitrary window is not derivable for it at all.
--
-- COST. One index scan on idx_cls_recent (team_id, sent_at DESC) over the
-- window, then a hash aggregate. The old path was an HTTP round trip to
-- EmailBison, so this is faster as well as correct.
--
-- ROLLBACK
--   DROP FUNCTION IF EXISTS analytics_prospects(BIGINT, DATE, DATE, BIGINT[], UUID[]);
--   -- the tile then returns to the workspace-wide figure, filters ignored.

BEGIN;

CREATE OR REPLACE FUNCTION analytics_prospects(
  p_team_id      BIGINT,
  p_from         DATE,
  p_to           DATE,
  p_campaign_ids BIGINT[] DEFAULT NULL,
  p_client_ids   UUID[]   DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE sql
STABLE
AS $$
  SELECT COUNT(DISTINCT s.lead_id)
  FROM campaign_lead_sends s
  WHERE s.team_id = p_team_id
    -- Half-open on the upper bound so the last day is whole regardless of the
    -- time of day a send landed. `p_to` is inclusive everywhere else on this
    -- page and must stay inclusive here.
    AND s.sent_at >= p_from::timestamptz
    AND s.sent_at <  (p_to + 1)::timestamptz
    AND (p_campaign_ids IS NULL OR s.campaign_id = ANY (p_campaign_ids))
    AND (
      p_client_ids IS NULL
      OR EXISTS (
        SELECT 1
        FROM campaign_clients cc
        WHERE cc.campaign_id = s.campaign_id
          AND cc.client_id = ANY (p_client_ids)
          -- A campaign the operator has explicitly unlinked from the client
          -- is not that client's, the same rule the campaign list applies.
          AND NOT cc.excluded
      )
    );
$$;

COMMENT ON FUNCTION analytics_prospects(BIGINT, DATE, DATE, BIGINT[], UUID[]) IS
  'EmailBison leads contacted in the window, each counted once, honouring the campaign and client filters. Replaces a workspace-wide call to EmailBison that ignored both.';

GRANT EXECUTE ON FUNCTION analytics_prospects(BIGINT, DATE, DATE, BIGINT[], UUID[])
  TO anon, authenticated, service_role;

COMMIT;
