#!/usr/bin/env node
/*
 * The Sequence tab and its save, against a DISPOSABLE Instantly campaign.
 *
 * The save is a WHOLE-SEQUENCE REPLACE — Instantly has no per-step endpoints —
 * so a partial payload silently deletes the rest. That is what these assertions
 * are for: they check what SURVIVES a save, not only what lands.
 *
 * Never activated; deleted at the end with retries.
 *   BASE=http://localhost:3111 npm run verify:sequence
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
const app = (path, init) => fetch(`${APP}${path}`, { ...init, headers: { "Content-Type": "application/json", cookie: `bsa_session=${TOKEN}`, ...(init?.headers ?? {}) } });

let pass = 0, fail = 0;
const ok = (n, d = "") => { pass++; console.log(`  ok    ${n}${d ? " — " + d : ""}`); };
const no = (n, w) => { fail++; console.log(`  FAIL  ${n} — ${w}`); };

const sched = { schedules: [{ name: "p", timing: { from: "09:00", to: "17:00" }, days: { 1: true }, timezone: "America/Detroit" }] };
let id = null;
console.log(`\ninstantly sequence: ${APP}\n`);
try {
  id = (await inst("POST", "/api/v2/campaigns", { name: "ZZZ-SEQUENCE-TEST", campaign_schedule: sched })).json?.id;
  console.log(`  campaign: ${id}\n`);

  /*
   * Sync it into our cache before reading it back. The detail endpoint answers
   * 404 for a campaign it has never seen — which is correct, and which made the
   * read-back assertions fail against a save that had worked perfectly.
   */
  await fetch(`${APP}/api/cron/sync-instantly-campaigns`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET ?? env.CRON_SECRET}` },
  });

  const steps = [
    { email_subject: "Step one {{RANDOM |Hi|Hello}}", email_body: "<p>Body one</p>", wait_in_days: 0, thread_reply: false, variant: false },
    { email_subject: "Variant of one", email_body: "<p>Variant body</p>", wait_in_days: 0, thread_reply: false, variant: true },
    { email_subject: "Step two", email_body: "<p>Body two</p>", wait_in_days: 3, thread_reply: false, variant: false },
  ];
  const save = await app(`/api/campaigns/${id}/sequence`, { method: "PUT", body: JSON.stringify({ steps }) });
  const body = await save.json();
  if (save.ok && body.steps === 2 && body.variants === 1) ok("save folds variants into their step", `${body.steps} steps, ${body.variants} variant`);
  else no("save folds variants into their step", `${save.status} ${JSON.stringify(body)}`);

  // Upstream is the authority.
  const up = await inst("GET", `/api/v2/campaigns/${id}`);
  const upSteps = up.json?.sequences?.[0]?.steps ?? [];
  if (upSteps.length === 2) ok("UPSTREAM HAS BOTH STEPS", `${upSteps.length}`);
  else no("UPSTREAM HAS BOTH STEPS", `${upSteps.length} — a replace dropped one`);
  if ((upSteps[0]?.variants ?? []).length === 2) ok("step one kept its variant", "2 variants");
  else no("step one kept its variant", `${(upSteps[0]?.variants ?? []).length}`);
  if (upSteps[1]?.delay === 3) ok("the delay round-trips", "3 days");
  else no("the delay round-trips", `delay=${upSteps[1]?.delay}`);

  // And the app reads it back in EmailBison's shape.
  const detail = await (await app(`/api/campaigns/${id}`)).json();
  const seq = detail.sequence ?? [];
  if (seq.length === 3) ok("the tab reads back all three rows", `${seq.length}`);
  else no("the tab reads back all three rows", `${seq.length}`);
  if (seq.filter((s) => s.isVariant).length === 1) ok("the variant is flagged", "1");
  else no("the variant is flagged", `${seq.filter((s) => s.isVariant).length}`);

  const empty = await app(`/api/campaigns/${id}/sequence`, { method: "PUT", body: JSON.stringify({ steps: [] }) });
  if (empty.status === 400) ok("an empty sequence is refused", "400");
  else no("an empty sequence is refused", `status ${empty.status}`);
} catch (e) {
  no("unexpected", e instanceof Error ? e.message : String(e));
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
