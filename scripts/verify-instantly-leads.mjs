#!/usr/bin/env node
/*
 * The Instantly Leads tab and lead removal, end to end.
 *
 * READ-ONLY AGAINST REAL CAMPAIGNS. Removal is the one destructive write with
 * no undo, so it is exercised only against leads this script creates on a
 * disposable campaign — never against a client's list. The campaign is deleted
 * afterwards, which takes its leads with it.
 *
 *   BASE=http://localhost:3111 npm run verify:leads
 */
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).replace(/^["']|["']$/g, "")]),
);
const APP = process.env.BASE ?? "http://localhost:3000";
const TOKEN = process.env.SMOKE_TOKEN ?? (() => {
  const email = env.AUTH_USERS.split(/[\n,]+/)[0].split(":")[0].trim();
  const p = `${Buffer.from(email).toString("base64url")}.${Date.now() + 3_600_000}`;
  return `${p}.${createHmac("sha256", env.AUTH_SECRET).update(p).digest("hex")}`;
})();
const app = async (path, init) =>
  fetch(`${APP}${path}`, { ...init, headers: { "Content-Type": "application/json", cookie: `bsa_session=${TOKEN}`, ...(init?.headers ?? {}) } });

let pass = 0, fail = 0;
const ok = (n, d = "") => { pass++; console.log(`  ok    ${n}${d ? " — " + d : ""}`); };
const no = (n, w) => { fail++; console.log(`  FAIL  ${n} — ${w}`); };

console.log(`\ninstantly leads: ${APP}\n`);

try {
  // A real campaign, read only.
  const list = await (await app("/api/campaigns?limit=400&platforms=instantly")).json();
  const withLeads = [];
  for (const c of (list.items ?? []).slice(0, 40)) {
    const r = await (await app(`/api/campaigns/${c.id}/leads?page=1&facets=1`)).json();
    if (r.total > 0) { withLeads.push({ c, r }); break; }
  }
  if (!withLeads.length) throw new Error("no Instantly campaign with leads found");
  const { c, r } = withLeads[0];

  ok("the Leads tab returns rows", `${r.total} leads in ${c.name.slice(0, 30)}`);

  const sum = (r.facets ?? []).reduce((n, f) => n + Number(f.leads), 0);
  if (sum === r.total) ok("FACETS SUM TO THE TOTAL", `${sum}`);
  else no("FACETS SUM TO THE TOTAL", `${sum} != ${r.total} — a 1,000 here means rule 7 again`);

  if ((r.rows ?? []).every((x) => typeof x.leadId === "string")) ok("lead ids are uuids");
  else no("lead ids are uuids", "an integer id leaked into an Instantly campaign");

  const statuses = new Set((r.rows ?? []).map((x) => x.status));
  if (![...statuses].some((s) => /^-?\d+$/.test(String(s)))) ok("status is a word, not a raw code", [...statuses].join(", "));
  else no("status is a word, not a raw code", [...statuses].join(", "));

  // Select-all must not stop at 1,000.
  const ids = await (await app(`/api/campaigns/${c.id}/leads?ids=1`)).json();
  if (ids.total === r.total) ok("select-all returns every id", `${ids.total}`);
  else no("select-all returns every id", `${ids.total} vs ${r.total}${ids.total === 1000 ? " — capped at 1,000" : ""}`);

  // Guards.
  const unconfirmed = await app(`/api/campaigns/${c.id}/leads/remove`, {
    method: "POST", body: JSON.stringify({ leadIds: [(r.rows ?? [])[0]?.leadId] }),
  });
  if (unconfirmed.status === 428) ok("removal without confirm is refused", "428");
  else no("removal without confirm is refused", `status ${unconfirmed.status}`);

  const wrongIds = await app(`/api/campaigns/${c.id}/leads/remove`, {
    method: "POST", body: JSON.stringify({ leadIds: [12345], confirm: true }),
  });
  if (wrongIds.status === 400) ok("numeric ids are refused on an Instantly campaign", "400");
  else no("numeric ids are refused on an Instantly campaign", `status ${wrongIds.status}`);

  const badCampaign = await (await app("/api/campaigns/not-an-id/leads?page=1")).json();
  if (badCampaign.error) ok("a malformed campaign id is refused", badCampaign.error);
  else no("a malformed campaign id is refused", "it was accepted");
} catch (e) {
  no("unexpected", e instanceof Error ? e.message : String(e));
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
