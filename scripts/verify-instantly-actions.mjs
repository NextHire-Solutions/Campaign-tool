#!/usr/bin/env node
/*
 * Bulk actions against a DISPOSABLE Instantly campaign, through the real API
 * route — so the route, the dispatcher, the audit write and the status
 * write-back are all exercised, not just the client.
 *
 * OPT-IN and not part of `npm test`: it writes to the live workspace.
 * Safe by construction — the campaign has 0 leads and 0 inboxes, so even
 * `resume` cannot email anyone — and it is deleted at the end with retries.
 *
 * Needs the app running:  BASE=http://localhost:3111 npm run verify:actions
 */
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).replace(/^["']|["']$/g, "")]),
);
const KEY = env.INSTANTLY_API_KEY, IB = env.INSTANTLY_BASE_URL || "https://api.instantly.ai";
const APP = process.env.BASE ?? "http://localhost:3000";

/*
 * Minted from .env.local by default. SMOKE_TOKEN overrides it, which is how
 * this runs against production — that deployment has a different AUTH_SECRET,
 * and a locally-minted token there is simply a 401 on every call.
 */
const TOKEN = process.env.SMOKE_TOKEN ?? (() => {
  const email = env.AUTH_USERS.split(/[\n,]+/)[0].split(":")[0].trim();
  const payload = `${Buffer.from(email).toString("base64url")}.${Date.now() + 3_600_000}`;
  return `${payload}.${createHmac("sha256", env.AUTH_SECRET).update(payload).digest("hex")}`;
})();

const inst = async (m, p, b) => {
  const r = await fetch(`${IB}${p}`, { method: m, headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, ok: r.ok, json: j, text: t.slice(0, 200) };
};
const act = async (action, targets, confirm = true) => {
  const r = await fetch(`${APP}/api/campaigns/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: `bsa_session=${TOKEN}` },
    body: JSON.stringify({ action, targets, confirm }),
  });
  return { status: r.status, body: await r.json() };
};

{
  // One auth check up front. Without it a bad token reports every check as
  // "undefined", which reads as a broken feature rather than a missing cookie.
  const probe = await fetch(`${APP}/api/campaigns?limit=1`, { headers: { cookie: `bsa_session=${TOKEN}` } });
  if (probe.status === 401) {
    console.error(`\n  Unauthorized against ${APP}. Set SMOKE_TOKEN for a deployment whose AUTH_SECRET differs from .env.local.\n`);
    process.exit(2);
  }
}

let pass = 0, fail = 0;
const ok = (n, d = "") => { pass++; console.log(`  ok    ${n}${d ? " — " + d : ""}`); };
const no = (n, w) => { fail++; console.log(`  FAIL  ${n} — ${w}`); };

const sched = { schedules: [{ name: "p", timing: { from: "09:00", to: "17:00" }, days: { 1: true }, timezone: "America/Detroit" }] };
let id = null;
try {
  id = (await inst("POST", "/api/v2/campaigns", { name: "ZZZ-BULK-ACTION-TEST", campaign_schedule: sched })).json?.id;
  console.log(`  campaign: ${id}\n`);

  // Sync it into our cache so the dispatcher can find it.
  /*
   * Same override as the session token, for the same reason: a deployment has
   * its own CRON_SECRET, and without it the sync never runs, the new campaign
   * never reaches the cache, and every action is refused with "Unknown
   * campaign" — which looks like a dispatcher bug and is really a missing
   * secret. (That refusal is the dispatcher's guard doing its job: it will not
   * act on a campaign whose status it cannot check.)
   */
  const cronSecret = process.env.CRON_SECRET ?? env.CRON_SECRET;
  await fetch(`${APP}/api/cron/sync-instantly-campaigns`, { method: "POST", headers: { Authorization: `Bearer ${cronSecret}` } });

  const target = [{ platform: "instantly", id }];

  // 1. ARCHIVE must be refused with the platform reason, not a status reason.
  const arch = await act("archive", target);
  const ar = arch.body?.results?.[0];
  if (ar?.skipped && /no archive/i.test(ar.error ?? "")) ok("archive is refused on Instantly", ar.error.slice(0, 58) + "…");
  else no("archive is refused on Instantly", JSON.stringify(ar));

  /*
   * The fixture has to reach the right STATUS before each action, because the
   * status rules apply identically on both platforms — a draft is not pausable
   * and only a paused campaign is resumable. The first version of this test
   * created a draft and then asserted pause worked; the dispatcher correctly
   * refused, which was the rule doing its job, not a bug.
   */
  await inst("POST", `/api/v2/campaigns/${id}/activate`, {});
  await fetch(`${APP}/api/cron/sync-instantly-campaigns`, { method: "POST", headers: { Authorization: `Bearer ${cronSecret}` } });

  // 2. PAUSE an active campaign, through our route.
  const pause = await act("pause", target);
  const pr = pause.body?.results?.[0];
  if (pr?.ok) ok("pause works on Instantly", `status=${pr.status}`);
  else no("pause works on Instantly", JSON.stringify(pr));

  // 3. The cache must reflect it, translated back to Instantly's integer.
  const list = await (await fetch(`${APP}/api/campaigns?limit=1&platforms=instantly&q=ZZZ-BULK`, { headers: { cookie: `bsa_session=${TOKEN}` } })).json();
  const cached = list.items?.[0];
  if (cached?.status === "paused") ok("cache reflects the new status", `status=${cached.status}`);
  else no("cache reflects the new status", `got ${cached?.status}`);

  // 4. RESUME a paused campaign — safe: 0 leads, 0 inboxes, so it cannot send.
  const res = await act("resume", target);
  const rr = res.body?.results?.[0];
  if (rr?.ok) ok("resume activates an Instantly campaign", `status=${rr.status}`);
  else no("resume activates an Instantly campaign", JSON.stringify(rr));

  // 5. Leave it paused rather than running, whatever else happened.
  await inst("POST", `/api/v2/campaigns/${id}/pause`, {});

  /*
   * 6. The confirm guard, which is the only thing standing between a click and
   * thousands of real emails. It must hold on BOTH platforms — Instantly's
   * resume is /activate, which starts sending exactly as EmailBison's does.
   */
  const unconfirmed = await act("resume", target, false);
  if (unconfirmed.status === 428) ok("resume without confirm is refused", "428");
  else no("resume without confirm is refused", `status ${unconfirmed.status}`);

  /*
   * 7. A MIXED BATCH must dispatch per row rather than per batch.
   *
   * The EmailBison half uses an action the STATUS refuses, so nothing on that
   * platform is mutated. An earlier ad-hoc version of this check used `archive`
   * against a real completed campaign and archived it — and EmailBison has no
   * unarchive, so that was permanent. A verification must never be the thing
   * that changes production.
   */
  const ebCompleted = await (await fetch(`${APP}/api/campaigns?limit=1&platforms=emailbison&status=completed`, { headers: { cookie: `bsa_session=${TOKEN}` } })).json();
  const ebId = ebCompleted.items?.[0]?.id;
  if (ebId) {
    const mixed = await act("resume", [
      { platform: "emailbison", id: String(ebId) },
      { platform: "instantly", id },
    ]);
    const rows = mixed.body?.results ?? [];
    const eb = rows.find((r) => r.platform === "emailbison");
    const ins = rows.find((r) => r.platform === "instantly");
    // Both refused, for DIFFERENT reasons, each resolved on its own platform.
    if (eb?.skipped && ins && rows.length === 2) {
      ok("a mixed batch dispatches per row", `eb: ${String(eb.error).slice(0, 34)}… | instantly handled`);
    } else {
      no("a mixed batch dispatches per row", JSON.stringify(rows).slice(0, 160));
    }
  }

  // 8. Upstream is the authority: confirm it really is paused.
  const upstream = await inst("GET", `/api/v2/campaigns/${id}`);
  if (upstream.json?.status === 2) ok("upstream really is paused", "status=2");
  else no("upstream really is paused", `status=${upstream.json?.status}`);
} catch (e) {
  no("unexpected", e.message);
} finally {
  if (id) {
    let removed = false;
    for (let i = 0; i < 6 && !removed; i++) {
      if (i) await new Promise(r => setTimeout(r, 8000));
      const d = await inst("DELETE", `/api/v2/campaigns/${id}`);
      removed = d.ok || d.status === 404;
    }
    console.log(`\n  cleanup: ${removed ? "removed" : "STILL EXISTS — remove by hand"}`);
  }
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
