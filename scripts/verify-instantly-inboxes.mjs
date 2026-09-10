#!/usr/bin/env node
/*
 * Inbox assignment on Instantly, through the real route, against a DISPOSABLE
 * campaign.
 *
 * The risk this exists to catch: Instantly has no attach/remove — a campaign's
 * inboxes ARE its `email_list`, so every change is a read-modify-write. Writing
 * only the new pool would DETACH everything already assigned, silently, with a
 * 200. So the assertions are about what SURVIVES a change, not just what lands.
 *
 * OPT-IN. The campaign is created here, never activated, and deleted at the end.
 *   BASE=http://localhost:3111 npm run verify:inboxes
 */
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).replace(/^["']|["']$/g, "")]),
);
const APP = process.env.BASE ?? "http://localhost:3000";
const KEY = env.INSTANTLY_API_KEY, IB = env.INSTANTLY_BASE_URL || "https://api.instantly.ai";
const TOKEN = process.env.SMOKE_TOKEN ?? (() => {
  const email = env.AUTH_USERS.split(/[\n,]+/)[0].split(":")[0].trim();
  const p = `${Buffer.from(email).toString("base64url")}.${Date.now() + 3_600_000}`;
  return `${p}.${createHmac("sha256", env.AUTH_SECRET).update(p).digest("hex")}`;
})();

const inst = async (m, p, b) => {
  const r = await fetch(`${IB}${p}`, { method: m, headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, ok: r.ok, json: j };
};
const assign = async (targets, tag, action) => {
  const r = await fetch(`${APP}/api/campaigns/inboxes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: `bsa_session=${TOKEN}` },
    /*
     * `confirm` is required by the route: changing a campaign's inboxes decides
     * which mailboxes send for it, so it is never an accidental call. Omitting
     * it here returned a 400 and four "undefined" failures — the guard doing
     * its job, not the feature failing.
     */
    body: JSON.stringify({ targets, tag, action, confirm: true }),
  });
  return { status: r.status, body: await r.json() };
};

let pass = 0, fail = 0;
const ok = (n, d = "") => { pass++; console.log(`  ok    ${n}${d ? " — " + d : ""}`); };
const no = (n, w) => { fail++; console.log(`  FAIL  ${n} — ${w}`); };

const sched = { schedules: [{ name: "p", timing: { from: "09:00", to: "17:00" }, days: { 1: true }, timezone: "America/Detroit" }] };
let id = null;
try {
  const pools = await (await fetch(`${APP}/api/campaigns/inboxes?platform=instantly`, { headers: { cookie: `bsa_session=${TOKEN}` } })).json();
  const small = (pools.tags ?? []).slice().sort((a, b) => a.inboxes - b.inboxes)[0];
  if (!small) throw new Error("no Instantly pools returned");
  ok("Instantly pools are listed", (pools.tags ?? []).map((t) => `${t.tag}(${t.inboxes})`).join(", "));

  id = (await inst("POST", "/api/v2/campaigns", { name: "ZZZ-INBOX-TEST", campaign_schedule: sched })).json?.id;
  console.log(`  campaign: ${id}\n`);
  const targets = [{ platform: "instantly", id }];

  // A pre-existing inbox that must SURVIVE the assignment.
  const accounts = await inst("GET", "/api/v2/accounts?limit=1");
  const keeper = accounts.json?.items?.[0]?.email;
  await inst("PATCH", `/api/v2/campaigns/${id}`, { email_list: [keeper] });

  const a = await assign(targets, small.tag, "attach");
  const ar = a.body?.results?.[0];
  if (ar?.ok) ok("attach a pool", `applied=${ar.applied} of ${small.inboxes}`);
  else no("attach a pool", JSON.stringify(ar));

  const after = (await inst("GET", `/api/v2/campaigns/${id}`)).json?.email_list ?? [];
  if (after.includes(keeper)) ok("THE PRE-EXISTING INBOX SURVIVED", `${after.length} total`);
  else no("THE PRE-EXISTING INBOX SURVIVED", `${keeper} was detached — read-modify-write is broken`);
  if (after.length >= small.inboxes) ok("the pool landed", `${after.length} inboxes`);
  else no("the pool landed", `${after.length} < ${small.inboxes}`);

  // Re-assigning the same pool must be a no-op, not a duplicate.
  const again = await assign(targets, small.tag, "attach");
  const gr = again.body?.results?.[0];
  const afterAgain = (await inst("GET", `/api/v2/campaigns/${id}`)).json?.email_list ?? [];
  if (gr?.applied === 0 && afterAgain.length === after.length) ok("re-assigning is a no-op", "applied=0, no duplicates");
  else no("re-assigning is a no-op", `applied=${gr?.applied}, ${after.length} → ${afterAgain.length}`);

  const rm = await assign(targets, small.tag, "remove");
  const rr = rm.body?.results?.[0];
  const afterRemove = (await inst("GET", `/api/v2/campaigns/${id}`)).json?.email_list ?? [];
  if (rr?.ok && afterRemove.includes(keeper)) ok("remove takes the pool off and keeps the rest", `${afterRemove.length} left, keeper intact`);
  else no("remove takes the pool off and keeps the rest", `applied=${rr?.applied}, ${afterRemove.length} left, keeper=${afterRemove.includes(keeper)}`);
} catch (e) {
  no("unexpected", e.message);
} finally {
  if (id) {
    let gone = false;
    for (let i = 0; i < 6 && !gone; i++) {
      if (i) await new Promise((r) => setTimeout(r, 8000));
      const d = await inst("DELETE", `/api/v2/campaigns/${id}`);
      gone = d.ok || d.status === 404;
    }
    console.log(`\n  cleanup: ${gone ? "removed" : "STILL EXISTS — remove by hand"}`);
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
