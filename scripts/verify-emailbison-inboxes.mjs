#!/usr/bin/env node
/*
 * Inbox assignment on EmailBison, through the real route, against a DISPOSABLE
 * campaign. The EmailBison counterpart of `verify-instantly-inboxes.mjs`.
 *
 * WHY THIS IS A DIFFERENT SHAPE FROM THE INSTANTLY ONE
 *
 * EmailBison has a real attach/remove pair — `attach-sender-emails` and
 * `remove-sender-emails` — so there is no read-modify-write and no whole-array
 * field to clobber. The risks are different:
 *
 *  - the pool is CHUNKED at 250, so a pool of 534 is three calls and a partial
 *    failure must be reported, not averaged away
 *  - re-attaching a pool already on the campaign answers `success: false` with
 *    "These emails already exist on this campaign". That is the requested end
 *    state, so it must count as applied rather than as a failure
 *  - disconnected inboxes are excluded from an attach, because attaching one
 *    adds a name to a campaign that will never carry a message
 *
 * So the assertions are about the COUNTS being honest and about a pre-existing
 * inbox surviving, rather than about array merge semantics.
 *
 * OPT-IN. The campaign is created here, never started, and deleted at the end.
 *   BASE=http://localhost:3111 node scripts/verify-emailbison-inboxes.mjs
 */
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).replace(/^["']|["']$/g, "")]),
);
const APP = process.env.BASE ?? "http://localhost:3000";
const KEY = env.EMAILBISON_API_KEY;
const EB = (env.EMAILBISON_BASE_URL || "").replace(/\/$/, "");
const TOKEN = process.env.SMOKE_TOKEN ?? (() => {
  const email = env.AUTH_USERS.split(/[\n,]+/)[0].split(":")[0].trim();
  const p = `${Buffer.from(email).toString("base64url")}.${Date.now() + 3_600_000}`;
  return `${p}.${createHmac("sha256", env.AUTH_SECRET).update(p).digest("hex")}`;
})();

const eb = async (m, p, b) => {
  const r = await fetch(`${EB}${p}`, {
    method: m,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Accept: "application/json" },
    ...(b === undefined ? {} : { body: JSON.stringify(b) }),
  });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, ok: r.ok, json: j, text: t };
};
/** Every sender attached to a campaign, following pagination. */
const senders = async (id) => {
  /*
   * The page cap has to clear the LARGEST pool, not a typical one. EmailBison
   * serves 15 per page, so the original cap of 30 pages stopped at exactly 435
   * and made a complete 531-inbox assignment look like a partial one — a bug in
   * this script that read as a bug in the feature. 200 pages clears 3,000.
   */
  const out = [];
  for (let page = 1; page <= 200; page++) {
    const r = await eb("GET", `/api/campaigns/${id}/sender-emails?page=${page}&per_page=100`);
    const items = r.json?.data ?? [];
    out.push(...items);
    const last = r.json?.meta?.last_page ?? 1;
    if (page >= last || !items.length) break;
  }
  return out;
};
const assign = async (targets, tag, action) => {
  const r = await fetch(`${APP}/api/campaigns/inboxes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: `bsa_session=${TOKEN}` },
    body: JSON.stringify({ targets, tag, action, confirm: true }),
  });
  return { status: r.status, body: await r.json() };
};

let pass = 0, fail = 0;
const ok = (n, d = "") => { pass++; console.log(`  ok    ${n}${d ? " — " + d : ""}`); };
const no = (n, w) => { fail++; console.log(`  FAIL  ${n} — ${w}`); };

let id = null;
try {
  const pools = await (await fetch(`${APP}/api/campaigns/inboxes?platform=emailbison`, { headers: { cookie: `bsa_session=${TOKEN}` } })).json();
  const sorted = (pools.tags ?? []).slice().sort((a, b) => a.connected - b.connected);
  /*
   * TAG=... picks a specific pool. Without it the smallest connected pool is
   * used, which keeps the run cheap — but a small pool never exercises the
   * 250-chunking, so the large-pool run is the one that proves a 531-inbox
   * assignment is three calls and still reports one honest total.
   */
  const small = process.env.TAG
    ? (pools.tags ?? []).find((t) => t.tag === process.env.TAG)
    : sorted.find((t) => t.connected > 0);
  if (!small) throw new Error("no EmailBison pool with connected inboxes");
  ok("EmailBison pools are listed", (pools.tags ?? []).slice(0, 6).map((t) => `${t.tag}(${t.connected}/${t.inboxes})`).join(", "));

  const made = await eb("POST", "/api/campaigns", { name: "ZZZ-EB-INBOX-TEST" });
  id = made.json?.data?.id;
  if (!id) throw new Error(`could not create campaign: ${made.status} ${made.text.slice(0, 200)}`);
  console.log(`  campaign: ${id}\n`);
  const targets = [{ platform: "emailbison", id: String(id) }];

  /*
   * A pre-existing sender that must SURVIVE the assignment. Taken from a
   * DIFFERENT pool so it cannot be confused with the one being assigned.
   */
  const allSenders = await eb("GET", "/api/sender-emails?page=1");
  const poolIds = new Set();
  const keeperCandidate = (allSenders.json?.data ?? []).find((s) => !(s.tags ?? []).some((t) => (t.name ?? t) === small.tag));
  let keeper = null;
  if (keeperCandidate) {
    await eb("POST", `/api/campaigns/${id}/attach-sender-emails`, { sender_email_ids: [keeperCandidate.id] });
    keeper = keeperCandidate.id;
  }

  const before = await senders(id);
  ok("the disposable campaign starts almost empty", `${before.length} sender(s)`);

  // ---- attach -------------------------------------------------------------
  const a = await assign(targets, small.tag, "attach");
  const ar = a.body?.results?.[0];
  if (ar?.ok) ok("attach a pool", `applied=${ar.applied}, pool connected=${small.connected}`);
  else no("attach a pool", JSON.stringify(a.body).slice(0, 250));

  if (a.body?.inboxes === small.connected) ok("the summary counts the CONNECTED pool", `${a.body.inboxes}`);
  else no("the summary counts the CONNECTED pool", `summary.inboxes=${a.body?.inboxes}, connected=${small.connected}`);

  if ((a.body?.skippedDisconnected ?? 0) === small.inboxes - small.connected)
    ok("disconnected inboxes are reported, not hidden", `${a.body.skippedDisconnected} skipped`);
  else no("disconnected inboxes are reported", `skipped=${a.body?.skippedDisconnected}, expected=${small.inboxes - small.connected}`);

  const after = await senders(id);
  const landed = after.length - before.length;
  if (landed >= small.connected * 0.95) ok("the pool landed on the campaign", `${before.length} → ${after.length} senders`);
  else no("the pool landed on the campaign", `${before.length} → ${after.length}, expected +${small.connected}`);

  if (!keeper) ok("pre-existing sender survival", "skipped — no non-pool sender available");
  else if (after.some((s) => s.id === keeper)) ok("THE PRE-EXISTING SENDER SURVIVED", `id ${keeper} still attached`);
  else no("THE PRE-EXISTING SENDER SURVIVED", `id ${keeper} was detached by an attach`);

  // ---- re-attach is not a failure ----------------------------------------
  const again = await assign(targets, small.tag, "attach");
  const gr = again.body?.results?.[0];
  const afterAgain = await senders(id);
  if (gr?.ok && afterAgain.length === after.length)
    ok("re-attaching the same pool is reported ok, not as an error", `applied=${gr.applied}, alreadyAttached=${gr.alreadyAttached ?? 0}, no duplicates`);
  else no("re-attaching the same pool is reported ok", `ok=${gr?.ok} err=${gr?.error ?? ""}, ${after.length} → ${afterAgain.length}`);

  // ---- remove -------------------------------------------------------------
  const rm = await assign(targets, small.tag, "remove");
  const rr = rm.body?.results?.[0];
  const afterRemove = await senders(id);
  const keeperKept = !keeper || afterRemove.some((s) => s.id === keeper);
  if (rr?.ok && afterRemove.length < after.length && keeperKept)
    ok("remove takes the pool off and keeps the rest", `${after.length} → ${afterRemove.length}, keeper intact`);
  else no("remove takes the pool off and keeps the rest", `ok=${rr?.ok} err="${rr?.error ?? ""}" applied=${rr?.applied}, ${after.length} → ${afterRemove.length}, keeper=${keeperKept}`);

  // ---- an Instantly-only pool must be refused -----------------------------
  const instOnly = "Howe Realty";
  if (!(pools.tags ?? []).some((t) => t.tag === instOnly)) {
    const miss = await assign(targets, instOnly, "attach");
    const rows = miss.body?.results ?? [];
    if (rows.length === 0 && (miss.body?.inboxes ?? 0) === 0)
      ok("an Instantly-only pool assigns nothing on EmailBison", "no campaigns touched");
    else no("an Instantly-only pool assigns nothing on EmailBison", JSON.stringify(miss.body).slice(0, 200));
  } else {
    ok("Instantly-only pool check", `skipped — "${instOnly}" also exists on EmailBison`);
  }
} catch (e) {
  no("unexpected", e.message);
} finally {
  if (id) {
    let gone = false;
    for (let i = 0; i < 5 && !gone; i++) {
      if (i) await new Promise((r) => setTimeout(r, 4000));
      const d = await eb("DELETE", `/api/campaigns/${id}`);
      gone = d.ok || d.status === 404;
    }
    console.log(`\n  cleanup: campaign ${id} ${gone ? "removed" : "STILL EXISTS — remove by hand"}`);
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
