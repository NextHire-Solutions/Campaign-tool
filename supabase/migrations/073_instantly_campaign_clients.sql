-- 073 — which client an Instantly campaign belongs to.
--
-- Every client-scoped number in the product is a rollup over the campaigns
-- belonging to that client. Without this, Instantly's 317 campaigns can be
-- counted in a workspace total but cannot appear under any client, and the
-- client filter would silently mean "EmailBison only".
--
-- A SEPARATE TABLE, not a column on campaign_clients, for the same reason
-- Instantly gets its own tables at all: campaign_clients.campaign_id is BIGINT
-- and Instantly campaigns are UUIDs. The two cannot share a primary key.
--
-- The MATCHING is deliberately the same code, not a second implementation.
-- Instantly follows the same naming convention as EmailBison — "Camelot Realty
-- Group - Houston", "Howe Realty Group (2) - Maricopa" — so matchCampaign()
-- resolves them with the rules that already work. Two matchers would mean two
-- definitions of which campaigns are a client's, and they would diverge.
--
-- `manual` pins survive a re-run, exactly as they do for EmailBison (rule 9):
-- a human decision is not something a sync gets to overwrite.

BEGIN;

CREATE TABLE IF NOT EXISTS instantly_campaign_clients (
  campaign_id    UUID PRIMARY KEY,
  client_id      UUID REFERENCES clients(id) ON DELETE SET NULL,
  match_method   TEXT NOT NULL DEFAULT 'auto',
  matched_on     TEXT,
  confidence     NUMERIC,
  ambiguous      BOOLEAN NOT NULL DEFAULT FALSE,
  excluded       BOOLEAN NOT NULL DEFAULT FALSE,
  exclude_reason TEXT,
  resolved_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_icc_client ON instantly_campaign_clients (client_id);
CREATE INDEX IF NOT EXISTS idx_icc_included
  ON instantly_campaign_clients (client_id) WHERE NOT excluded;

ALTER TABLE instantly_campaign_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE instantly_campaign_clients FORCE  ROW LEVEL SECURITY;
REVOKE ALL ON instantly_campaign_clients FROM anon, authenticated;

INSERT INTO schema_migrations (version) VALUES ('073_instantly_campaign_clients')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
