-- 062 — did they reply from a personal mailbox or a work one?
--
-- An eighth card on the Replies view, and the one with the clearest action
-- behind it. Measured before building:
--
--   personal      3,030 replies   331 positive   10.9% positive rate
--   professional  2,127 replies   156 positive    7.3% positive rate
--
-- Agents reply more from personal addresses, and those replies convert half
-- again as well. That is a targeting fact, and nothing in the product could
-- see it.
--
-- THIS IS NOT THE ESP DIMENSION WEARING A HAT. 059 answers "which mail system
-- is behind this address" — a DNS fact. This answers "is this their own mailbox
-- or their employer's" — an identity fact. They come apart constantly and that
-- is the whole point: `agent@compass.com` and `agent@gmail.com` are BOTH Google
-- Workspace, and one is a corporate mailbox read at a desk while the other is a
-- phone. It also explains a number 059 raised and could not answer: 88.3% of
-- repliers are on Google, but only 55.6% are on gmail.com.
--
-- WHY A TABLE AND NOT A LIST IN SQL. The classification is exactly "is this
-- domain a public mailbox host", which is a fact about ~120 domains and not a
-- rule that can be derived. MX cannot decide it (gmail.com and compass.com have
-- the same MX). Held as data so a domain can be added with an INSERT rather
-- than a migration and a deploy — the list will need extending, and needing a
-- release to do it is how it stops being extended.
--
-- ANYTHING NOT ON THE LIST IS PROFESSIONAL, which is the safe default: a
-- misfiled consumer domain understates the personal side, and personal is the
-- side the finding favours. The error works against the claim, not for it.

BEGIN;

CREATE TABLE IF NOT EXISTS consumer_email_domains (
  domain TEXT PRIMARY KEY,
  note   TEXT
);

ALTER TABLE consumer_email_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumer_email_domains FORCE  ROW LEVEL SECURITY;
REVOKE ALL ON consumer_email_domains FROM anon, authenticated;

INSERT INTO consumer_email_domains (domain, note) VALUES
  -- The majors. gmail alone is 55.6% of every reply we have.
  ('gmail.com', 'major'), ('googlemail.com', 'major'),
  ('yahoo.com', 'major'), ('ymail.com', 'major'), ('rocketmail.com', 'major'),
  ('yahoo.co.uk', 'major'), ('yahoo.ca', 'major'),
  ('hotmail.com', 'major'), ('outlook.com', 'major'), ('live.com', 'major'),
  ('msn.com', 'major'), ('hotmail.co.uk', 'major'), ('outlook.es', 'major'),
  ('aol.com', 'major'), ('aim.com', 'major'),
  ('icloud.com', 'major'), ('me.com', 'major'), ('mac.com', 'major'),
  -- US ISP mailboxes. Heavily represented among established agents, who have
  -- often had the same address since their ISP gave it to them.
  ('comcast.net', 'isp'), ('att.net', 'isp'), ('sbcglobal.net', 'isp'),
  ('verizon.net', 'isp'), ('bellsouth.net', 'isp'), ('cox.net', 'isp'),
  ('charter.net', 'isp'), ('earthlink.net', 'isp'), ('juno.com', 'isp'),
  ('netzero.net', 'isp'), ('optonline.net', 'isp'), ('windstream.net', 'isp'),
  ('frontier.com', 'isp'), ('frontiernet.net', 'isp'), ('embarqmail.com', 'isp'),
  ('centurylink.net', 'isp'), ('centurytel.net', 'isp'), ('cableone.net', 'isp'),
  ('suddenlink.net', 'isp'), ('mchsi.com', 'isp'), ('wowway.com', 'isp'),
  ('pacbell.net', 'isp'), ('ameritech.net', 'isp'), ('swbell.net', 'isp'),
  ('prodigy.net', 'isp'), ('roadrunner.com', 'isp'), ('twc.com', 'isp'),
  ('rr.com', 'isp'), ('nc.rr.com', 'isp'), ('carolina.rr.com', 'isp'),
  ('tampabay.rr.com', 'isp'), ('cfl.rr.com', 'isp'), ('nyc.rr.com', 'isp'),
  ('socal.rr.com', 'isp'), ('san.rr.com', 'isp'), ('austin.rr.com', 'isp'),
  ('wi.rr.com', 'isp'), ('kc.rr.com', 'isp'), ('indy.rr.com', 'isp'),
  ('triad.rr.com', 'isp'), ('columbus.rr.com', 'isp'), ('neo.rr.com', 'isp'),
  ('woh.rr.com', 'isp'), ('cinci.rr.com', 'isp'), ('satx.rr.com', 'isp'),
  ('hvc.rr.com', 'isp'), ('stny.rr.com', 'isp'), ('ec.rr.com', 'isp'),
  ('maine.rr.com', 'isp'), ('elp.rr.com', 'isp'), ('hawaii.rr.com', 'isp'),
  ('twcny.rr.com', 'isp'), ('insightbb.com', 'isp'), ('ptd.net', 'isp'),
  ('snet.net', 'isp'), ('flash.net', 'isp'), ('bresnan.net', 'isp'),
  ('citlink.net', 'isp'), ('fuse.net', 'isp'), ('zoominternet.net', 'isp'),
  ('metrocast.net', 'isp'), ('atlanticbb.net', 'isp'), ('gci.net', 'isp'),
  ('consolidated.net', 'isp'), ('hargray.com', 'isp'), ('nctv.com', 'isp'),
  -- Privacy and free-tier providers people choose deliberately.
  ('protonmail.com', 'privacy'), ('proton.me', 'privacy'), ('pm.me', 'privacy'),
  ('tutanota.com', 'privacy'), ('hushmail.com', 'privacy'),
  ('fastmail.com', 'free'), ('fastmail.fm', 'free'), ('mail.com', 'free'),
  ('gmx.com', 'free'), ('gmx.net', 'free'), ('gmx.de', 'free'),
  ('inbox.com', 'free'), ('lycos.com', 'free'), ('excite.com', 'free'),
  ('mailfence.com', 'free'), ('zohomail.com', 'free'),
  -- Non-US consumer mail, for the occasional overseas address.
  ('mail.ru', 'intl'), ('yandex.ru', 'intl'), ('yandex.com', 'intl'),
  ('qq.com', 'intl'), ('163.com', 'intl'), ('126.com', 'intl'),
  ('sina.com', 'intl'), ('naver.com', 'intl'), ('daum.net', 'intl'),
  ('hanmail.net', 'intl'), ('rediffmail.com', 'intl'),
  ('web.de', 'intl'), ('t-online.de', 'intl'), ('freenet.de', 'intl'),
  ('orange.fr', 'intl'), ('wanadoo.fr', 'intl'), ('free.fr', 'intl'),
  ('laposte.net', 'intl'), ('sfr.fr', 'intl'),
  ('libero.it', 'intl'), ('virgilio.it', 'intl'), ('alice.it', 'intl'),
  ('tiscali.it', 'intl'), ('terra.com', 'intl'), ('uol.com.br', 'intl'),
  ('bol.com.br', 'intl'), ('telus.net', 'intl'), ('shaw.ca', 'intl'),
  ('sympatico.ca', 'intl'), ('rogers.com', 'intl'), ('bell.net', 'intl'),
  ('videotron.ca', 'intl'), ('btinternet.com', 'intl'), ('sky.com', 'intl'),
  ('talktalk.net', 'intl'), ('virginmedia.com', 'intl'), ('ntlworld.com', 'intl'),
  ('blueyonder.co.uk', 'intl'), ('bigpond.com', 'intl'), ('optusnet.com.au', 'intl')
ON CONFLICT (domain) DO NOTHING;

/*
 * The source vocabulary admits one more. `reply_esp` was the first dimension
 * that described the REPLY rather than the lead; this is the second.
 */
ALTER TABLE reply_dimensions DROP CONSTRAINT IF EXISTS reply_dimensions_source_check;
ALTER TABLE reply_dimensions ADD CONSTRAINT reply_dimensions_source_check
  CHECK (source IN ('client', 'lead_field', 'lead_attribute', 'reply_esp', 'reply_mailbox'));

INSERT INTO reply_dimensions (team_id, key, label, source, source_key, bucket, active, sort_position)
SELECT 2, 'mailbox_kind', 'Personal vs work email', 'reply_mailbox', NULL, NULL, TRUE,
       COALESCE((SELECT MAX(sort_position) + 1 FROM reply_dimensions WHERE team_id = 2), 10)
WHERE NOT EXISTS (
  SELECT 1 FROM reply_dimensions
   WHERE team_id = 2 AND key = 'mailbox_kind' AND client_id IS NULL
);

INSERT INTO schema_migrations (version) VALUES ('062_mailbox_kind')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
