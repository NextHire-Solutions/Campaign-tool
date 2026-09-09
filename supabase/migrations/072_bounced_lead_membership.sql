-- 072 — a lead that bounced is a lead we contacted.
--
-- Reported from campaign 194: EmailBison says 8 bounces, the Leads tab said 2.
--
-- Both were right about different things. 8 is bounce EVENTS (a dead mailbox
-- bounces once per send) and the campaign Overview shows 8 too, straight from
-- EmailBison's counter. The Leads tab counts distinct bounced PEOPLE, and it
-- said 2 when the true figure is 6.
--
-- ---------------------------------------------------------------------------
-- THE CAUSE, WHICH IS SYSTEMATIC AND WORKSPACE-WIDE.
--
-- campaign_leads is derived entirely from campaign_lead_sends, which is built
-- from `/api/scheduled-emails?status=sent`. EmailBison does not keep a `sent`
-- row for most hard bounces — so the lead never enters campaign_leads and is
-- invisible to the Leads tab. Measured across every campaign:
--
--   bounced (campaign, lead) pairs      5,860
--   with a send row we recorded           520
--   MISSING a send row                  5,340     <- 91%
--
-- So the tab's bounce facet was undercounting by roughly nine tenths
-- everywhere, and it undercounts precisely the leads someone goes looking for.
--
-- ---------------------------------------------------------------------------
-- THE FIX: A REPLY IS ALSO PROOF OF CONTACT.
--
-- You cannot bounce, or reply, without having been emailed. So membership is
-- the union of "we have a send row" and "we have a reply row", with the
-- send-derived row winning wherever both exist — it carries real dates, a step
-- and a sending inbox, and the reply-derived one carries none of that.
--
-- WHICH IS WHY `sends` BECOMES NULLABLE. It is NOT NULL DEFAULT 0 today, and a
-- reply-only row would therefore read "0 sends" — indistinguishable from a lead
-- that was never emailed, which is the exact opposite of what a bounce proves.
-- NULL reaches the DOM as a dash (rule 1): we know they were contacted, we do
-- not know how many times. The same applies to opens and clicks.

BEGIN;

/*
 * Widening only — every existing row keeps its value, and nothing that reads
 * these columns has to change.
 */
ALTER TABLE campaign_leads ALTER COLUMN sends        DROP NOT NULL;
ALTER TABLE campaign_leads ALTER COLUMN opens        DROP NOT NULL;
ALTER TABLE campaign_leads ALTER COLUMN unique_opens DROP NOT NULL;
ALTER TABLE campaign_leads ALTER COLUMN clicks       DROP NOT NULL;

CREATE OR REPLACE FUNCTION public.refresh_campaign_leads(
  p_team_id bigint,
  p_campaign_ids bigint[]
)
RETURNS integer
LANGUAGE plpgsql
AS $function$
DECLARE
  v_rows INTEGER;
  v_extra INTEGER;
BEGIN
  INSERT INTO campaign_leads AS cl (
    campaign_id, team_id, lead_id, first_sent_at, last_sent_at, sends,
    step_reached, last_step_id, sender_email_id, opens, unique_opens, clicks, computed_at
  )
  SELECT
    s.campaign_id,
    p_team_id,
    s.lead_id,
    MIN(s.sent_at),
    MAX(s.sent_at),
    COUNT(*)::INTEGER,
    -- A variant resolves to its parent's position; see the column comment.
    MAX(COALESCE(st.step_order, parent.step_order))::INTEGER,
    (ARRAY_AGG(s.sequence_step_id ORDER BY s.sent_at DESC NULLS LAST))[1],
    (ARRAY_AGG(s.sender_email_id  ORDER BY s.sent_at DESC NULLS LAST))[1],
    COALESCE(SUM(s.opens), 0)::INTEGER,
    COALESCE(SUM(s.unique_opens), 0)::INTEGER,
    COALESCE(SUM(s.clicks), 0)::INTEGER,
    NOW()
  FROM campaign_lead_sends s
  LEFT JOIN sequence_steps st     ON st.id = s.sequence_step_id
  LEFT JOIN sequence_steps parent ON parent.id = st.variant_from_step_id
  WHERE s.team_id = p_team_id
    AND s.campaign_id = ANY(p_campaign_ids)
  GROUP BY s.campaign_id, s.lead_id
  ON CONFLICT (campaign_id, lead_id) DO UPDATE SET
    first_sent_at   = EXCLUDED.first_sent_at,
    last_sent_at    = EXCLUDED.last_sent_at,
    sends           = EXCLUDED.sends,
    step_reached    = EXCLUDED.step_reached,
    last_step_id    = EXCLUDED.last_step_id,
    sender_email_id = EXCLUDED.sender_email_id,
    opens           = EXCLUDED.opens,
    unique_opens    = EXCLUDED.unique_opens,
    clicks          = EXCLUDED.clicks,
    computed_at     = NOW();

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  /*
   * Second pass: anyone who replied or bounced but has no surviving send row.
   *
   * DO NOTHING on conflict, deliberately. The send-derived row above is
   * strictly better — it has dates, a step and an inbox — so where both exist
   * it must stand. This pass only ever ADDS people who would otherwise be
   * missing entirely.
   *
   * Every send-derived column is left NULL rather than zeroed: a bounce proves
   * contact happened, it does not tell us when, from which inbox, or how often,
   * and inventing a 0 would make "we don't know" look like "we never sent".
   * removed_at is untouched, so a lead removed from a campaign does not come
   * back through this door (065).
   */
  INSERT INTO campaign_leads AS cl (
    campaign_id, team_id, lead_id, sends, opens, unique_opens, clicks, computed_at
  )
  -- Explicitly typed: a bare NULL in a SELECT list is inferred as `text` and
  -- the insert fails on the integer columns.
  SELECT DISTINCT r.campaign_id, p_team_id, r.lead_id,
         NULL::INTEGER, NULL::INTEGER, NULL::INTEGER, NULL::INTEGER, NOW()
  FROM replies r
  WHERE r.team_id = p_team_id
    AND r.campaign_id = ANY(p_campaign_ids)
    AND r.lead_id IS NOT NULL
  ON CONFLICT (campaign_id, lead_id) DO NOTHING;

  GET DIAGNOSTICS v_extra = ROW_COUNT;

  RETURN v_rows + v_extra;
END;
$function$;

/*
 * Backfill the history in one pass. Ongoing runs only touch campaigns with new
 * sends, so without this every bounce older than the next sync stays invisible.
 */
SELECT refresh_campaign_leads(
  2,
  ARRAY(SELECT DISTINCT campaign_id FROM replies
         WHERE team_id = 2 AND campaign_id IS NOT NULL AND lead_id IS NOT NULL)
);

INSERT INTO schema_migrations (version) VALUES ('072_bounced_lead_membership')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
