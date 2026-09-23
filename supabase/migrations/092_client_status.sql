-- 092 — a client has a status, not just a boolean.
--
-- WHAT WAS WRONG. Every one of the 53 rows in `clients` carried active = true,
-- including twelve the client had confirmed as paused or churned. So the
-- Clients screen showed 53 where the real roster is 35, and campaigns for
-- clients who left months ago sat in the list beside live ones.
--
-- `active` could not fix that on its own. Paused and churned are not the same
-- thing and must not be flattened into one flag: a paused client comes back
-- and their campaigns and history must be waiting; a churned one does not. The
-- client's own rule is that status drives the rest of the system — "if a client
-- is paused or churned, their campaigns should be paused and their portal
-- turned off" — and a boolean cannot express which of those two happened.
--
-- The vocabulary is deliberately the same four words os_clients already uses
-- (active / paused / churned / prospect), so the two systems can be compared
-- without a translation table in between.
--
-- `active` IS KEPT AND KEPT IN STEP, rather than dropped. It is read by
-- /api/clients and by the clients page today, and a migration that removes a
-- column those read is a deploy ordering problem for no benefit. The trigger
-- below makes `active` a view of `status`, so old readers keep working and
-- cannot disagree with the new column.
--
-- CHURN IS NOT A TOMBSTONE. Nothing is deleted here. A churned client keeps its
-- row, its campaign mappings and its history; campaign_clients points at it
-- with ON DELETE CASCADE, so removing the row would erase that client's sends
-- from every chart. The sends happened.

BEGIN;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'clients_status_check'
  ) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_status_check
      CHECK (status IN ('active', 'paused', 'churned', 'prospect'));
  END IF;
END $$;

-- Seed from the flag that exists, so nothing starts out contradicting itself.
UPDATE public.clients SET status = CASE WHEN active THEN 'active' ELSE 'churned' END;

COMMENT ON COLUMN public.clients.status IS
  'active | paused | churned | prospect. The authority; `active` mirrors it.';

/*
 * Keep `active` a mirror of `status`, in both directions:
 *   - set status, and active follows,
 *   - set active (an older caller), and status follows.
 * Without the second half, the existing PATCH route that writes `active` would
 * silently leave status stale and the two would drift apart.
 */
CREATE OR REPLACE FUNCTION public.clients_sync_active()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.active := (NEW.status = 'active');
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.active := (NEW.status = 'active');
  ELSIF NEW.active IS DISTINCT FROM OLD.active THEN
    -- An older caller flipped the boolean. Only 'active' is unambiguous;
    -- switching off could mean paused or churned, so it takes the weaker of
    -- the two and a person can correct it to churned.
    NEW.status := CASE WHEN NEW.active THEN 'active' ELSE 'paused' END;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS clients_sync_active ON public.clients;
CREATE TRIGGER clients_sync_active
  BEFORE INSERT OR UPDATE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.clients_sync_active();

CREATE INDEX IF NOT EXISTS clients_status_idx ON public.clients (team_id, status);

COMMIT;
