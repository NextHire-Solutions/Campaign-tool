-- 093 — the client lifecycle vocabulary, as the architecture spec defines it.
--
-- The spec names four statuses and asks that they be universal across every
-- tool: Onboarding, Active, Paused, Churned. 092 introduced `status` here with
-- the vocabulary os_clients already used, which had `prospect` where the spec
-- has `onboarding`. Two words for one idea is exactly what the spec calls out
-- ("different terminology for the same piece of information"), so this settles
-- it on the spec's word.
--
-- SAFE BECAUSE NOTHING IS A PROSPECT. Checked before writing this: zero rows
-- carry 'prospect' in this table or in os_clients, so no row changes value and
-- no reader sees a status it has not seen before. The UPDATE below is there
-- only so a re-run after someone has set one is still correct.
--
-- NOT TOUCHED: orch_clients.status in the onboarding database. That column is
-- a PIPELINE — new -> assigned -> copy_sent -> copy_approved -> team_built ->
-- leads_built -> campaign_launched -> live -> paused — and answers "how far
-- through onboarding is this client", not "is this client active". The two
-- share the word 'paused' and mean different things by it. Folding one into
-- the other would destroy the onboarding board, so the pipeline keeps its own
-- vocabulary and OS maps it to a lifecycle status when it reads it.

BEGIN;

-- Find the constraint by what it constrains, not by a name Postgres generated.
DO $$
DECLARE
  con_name TEXT;
BEGIN
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'public.clients'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%status%';

  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.clients DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

-- Any stragglers, before the new constraint refuses them.
UPDATE public.clients SET status = 'onboarding' WHERE status = 'prospect';

ALTER TABLE public.clients
  ADD CONSTRAINT clients_status_check
  CHECK (status IN ('onboarding', 'active', 'paused', 'churned'));

COMMENT ON COLUMN public.clients.status IS
  'onboarding | active | paused | churned — the platform-wide client lifecycle. '
  'Mastered in os_clients; this column is the local copy this tool reads.';

/*
 * `active` still mirrors `status`, and onboarding counts as NOT active: a
 * client being set up is not yet receiving the service, which is the spec's
 * own definition. The trigger from 092 already derives `active` as
 * (status = 'active'), so onboarding lands on false without a change here —
 * restated in the comment because it is the kind of thing a reader assumes
 * the other way round.
 */

COMMIT;
