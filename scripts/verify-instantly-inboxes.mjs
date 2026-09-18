#!/usr/bin/env node
/*
 * Inbox assignment on Instantly, through the real route, against a DISPOSABLE
 * campaign.
 *
 * WHAT CHANGED, AND WHY THE ASSERTIONS DID TOO
 *
 * Instantly has two independent ways to give a campaign its inboxes:
 *
 *   email_list      a frozen array of addresses
 *   email_tag_list  the POOL assignment — live, and what this estate uses
 *
 * Measured on the workspace: every campaign with real send volume assigns
 * through `email_tag_list` and has `email_list` empty. So the feature writes
 * tags, and these assertions are about the tag list.
 *
 * The risk this exists to catch is unchanged in shape: `email_tag_list` is a
 * whole-array replace, so writing only the tag being assigned would DETACH
 * every other pool on the campaign — silently, with a 200. A campaign really
 * can carry several (Howe Realty campaigns carry two). So the assertions are
 * about what SURVIVES a change, not just what lands.
 *
 * Also asserted: an explicitly pinned `email_list` is left alone. The two
 * fields are independent, and a campaign deliberately pinned to specific
 * addresses must not be disturbed by a pool assignment.
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
const tagList = async (id) => (await inst("GET", `/api/v2/campaigns/${id}`)).json?.email_tag_list ?? [];
const mailList = async (id) => (await inst("GET", `/api/v2/campaigns/${id}`)).json?.email_list ?? [];

let pass = 0, fail = 0;
const ok = (n, d = "") => { pass++; console.log(`  ok    ${n}${d ? " — " + d : ""}`); };
const no = (n, w) => { fail++; console.log(`  FAIL  ${n} — ${w}`); };

const sched = { schedules: [{ name: "p", timing: { from: "09:00", to: "17:00" }, days: { 1: true }, timezone: "America/Detroit" }] };
let id = null;
try {
  const pools = await (await fetch(`${APP}/api/campaigns/inboxes?platform=instantly`, { headers: { cookie: `bsa_session=${TOKEN}` } })).json();
  const sorted = (pools.tags ?? []).slice().sort((a, b) => a.inboxes - b.inboxes);
  const small = sorted[0];
  const other = sorted[1];
  if (!small) throw new Error("no Instantly pools returned");
  ok("Instantly pools are listed", (pools.tags ?? []).map((t) => `${t.tag}(${t.inboxes})`).join(", "));

  // Tag NAME → the id `email_tag_list` actually holds.
  const custom = (await inst("GET", "/api/v2/custom-tags?limit=100")).json?.items ?? [];
  const idFor = (label) => custom.find((t) => (t.label ?? t.name ?? "").trim().toLowerCase() === label.toLowerCase())?.id;
  const smallId = idFor(small.tag), otherId = other ? idFor(other.tag) : null;
  if (smallId) ok("the pool name resolves to a tag id", `${small.tag} → ${smallId}`);
  else no("the pool name resolves to a tag id", `${small.tag} has no id`);

  id = (await inst("POST", "/api/v2/campaigns", { name: "ZZZ-INBOX-TEST", campaign_schedule: sched })).json?.id;
  console.log(`  campaign: ${id}\n`);
  const targets = [{ platform: "instantly", id }];

  /*
   * Two things that must SURVIVE the assignment: a second pool already on the
   * campaign, and an explicitly pinned address. Both are whole-array fields.
   */
  const accounts = await inst("GET", "/api/v2/accounts?limit=1");
  const keeper = accounts.json?.items?.[0]?.email;
  await inst("PATCH", `/api/v2/campaigns/${id}`, { email_list: [keeper] });
  if (otherId) await inst("PATCH", `/api/v2/campaigns/${id}`, { email_tag_list: [otherId] });

  const a = await assign(targets, small.tag, "attach");
  const ar = a.body?.results?.[0];
  if (ar?.ok) ok("attach a pool", `applied=${ar.applied} (pool of ${small.inboxes})`);
  else no("attach a pool", JSON.stringify(ar));

  const after = await tagList(id);
  if (after.includes(smallId)) ok("the pool landed as a TAG", `email_tag_list=${after.length}`);
  else no("the pool landed as a TAG", `${smallId} not in ${JSON.stringify(after)}`);

  if (!otherId) ok("second-pool survival", "skipped — only one pool exists");
  else if (after.includes(otherId)) ok("THE OTHER POOL SURVIVED", `both tags present`);
  else no("THE OTHER POOL SURVIVED", `${other.tag} was detached — read-modify-write is broken`);

  const pinned = await mailList(id);
  if (pinned.includes(keeper)) ok("THE PINNED ADDRESS SURVIVED", `email_list untouched (${pinned.length})`);
  else no("THE PINNED ADDRESS SURVIVED", `${keeper} was lost — tags must not touch email_list`);

  // `applied` is the POOL SIZE, not the number of fields written.
  if (ar?.applied === small.inboxes) ok("applied reports the pool size", `${ar.applied}`);
  else no("applied reports the pool size", `applied=${ar?.applied}, pool=${small.inboxes}`);

  // Re-assigning the same pool must be a no-op, not a duplicate tag.
  const again = await assign(targets, small.tag, "attach");
  const gr = again.body?.results?.[0];
  const afterAgain = await tagList(id);
  if (gr?.applied === 0 && afterAgain.length === after.length) ok("re-assigning is a no-op", "applied=0, no duplicate tag");
  else no("re-assigning is a no-op", `applied=${gr?.applied}, ${after.length} → ${afterAgain.length}`);

  const rm = await assign(targets, small.tag, "remove");
  const rr = rm.body?.results?.[0];
  const afterRemove = await tagList(id);
  const keptOther = !otherId || afterRemove.includes(otherId);
  if (rr?.ok && !afterRemove.includes(smallId) && keptOther) ok("remove takes the pool off and keeps the rest", `${afterRemove.length} tag(s) left`);
  else no("remove takes the pool off and keeps the rest", `applied=${rr?.applied}, left=${JSON.stringify(afterRemove)}`);

  /*
   * A pool that exists on EmailBison but not on Instantly must FAIL LOUDLY.
   * Writing nothing and reporting success is the outcome this guards against:
   * the dialog would claim a pool was applied that never was.
   */
  const ebOnly = "Zapmail";
  if (!custom.some((t) => (t.label ?? t.name ?? "").trim().toLowerCase() === ebOnly.toLowerCase())) {
    const miss = await assign(targets, ebOnly, "attach");
    const mr = miss.body?.results?.[0];
    if (mr && !mr.ok && /no instantly inbox tag/i.test(mr.error ?? "")) ok("an EmailBison-only pool is refused, not silently skipped", mr.error);
    else no("an EmailBison-only pool is refused, not silently skipped", JSON.stringify(mr));
  } else {
    ok("EmailBison-only pool check", `skipped — "${ebOnly}" also exists on Instantly`);
  }
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
