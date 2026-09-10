#!/usr/bin/env node
/*
 * Every filter, checked for the two ways a filter can lie.
 *
 * This exists because both failures shipped, and neither was visible from
 * looking at a page:
 *
 *   INERT   — the Campaigns filter on the Volume tab changed nothing at all.
 *             Selecting a campaign left the total at 251,963.
 *   LEAKY   — the Campaign filter plus Instantly returned the whole Instantly
 *             workspace, reporting 43,283 sent for a campaign that sent 2.
 *
 * A filter that does nothing and a filter that does too much both render as a
 * perfectly normal-looking page, which is why this asserts on NUMBERS.
 *
 * Each check states what it expects and why:
 *   narrows   — the filtered figure must be strictly smaller than unfiltered
 *   changes   — the response must differ (direction not knowable in advance)
 *   inert     — documented as having no effect; asserted so it stays that way
 *
 *   BASE=https://analytics.brokerstaffer.com node scripts/check-filters.mjs
 */

import { createHmac } from "node:crypto";

const BASE = process.env.BASE ?? "http://localhost:3000";

function token() {
  if (process.env.SMOKE_TOKEN) return process.env.SMOKE_TOKEN;
  const secret = process.env.AUTH_SECRET;
  const users = process.env.AUTH_USERS;
  if (!secret || !users) {
    console.error("Need SMOKE_TOKEN, or AUTH_SECRET + AUTH_USERS.");
    process.exit(2);
  }
  const email = users.split(/[\n,]+/)[0].split(":")[0].trim();
  const payload = `${Buffer.from(email).toString("base64url")}.${Date.now() + 86_400_000}`;
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

const COOKIE = `bsa_session=${token()}`;

async function get(path) {
  const r = await fetch(`${BASE}${path}`, { headers: { cookie: COOKIE } });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}

const failures = [];
const ok = (name, detail) => console.log(`  ok    ${name}${detail ? ` — ${detail}` : ""}`);
const bad = (name, why) => {
  failures.push(name);
  console.log(`  FAIL  ${name} — ${why}`);
};

/** Pull a comparable number out of any of our response shapes. */
const metric = {
  kpiSent: (j) => Number(j?.current?.sent ?? NaN),
  kpiReplies: (j) => Number(j?.current?.replies ?? NaN),
  rowCount: (j) => (j?.rows ?? []).length,
  rowsSent: (j) => (j?.rows ?? []).reduce((n, r) => n + Number(r.sent ?? 0), 0),
  volumeTotal: (j) => Number(j?.total ?? NaN),
  pointsSent: (j) => (j?.points ?? []).reduce((n, p) => n + Number(p.sent ?? 0), 0),
  count: (j) => Number(j?.count ?? (j?.rows ?? []).length),
  /*
   * The management list answers with `items`/`total`, not `rows`/`count`.
   * Reading the wrong key returned 0 for both sides and reported three working
   * filters as broken — a false failure costs the same trust as a false pass.
   */
  mgmtTotal: (j) => Number(j?.total ?? NaN),
  problems: (j) => (j?.problems ?? []).length,
};

/**
 * @param mode "narrows" | "changes" | "inert"
 */
async function check(name, basePath, filteredPath, read, mode = "narrows") {
  let a, b;
  try {
    [a, b] = await Promise.all([get(basePath), get(filteredPath)]);
  } catch (e) {
    bad(name, `request failed: ${e.message}`);
    return;
  }
  const x = read(a);
  const y = read(b);

  if (Number.isNaN(x) || Number.isNaN(y)) {
    bad(name, `could not read a comparable number (${x} → ${y})`);
    return;
  }
  if (mode === "inert") {
    if (x !== y) bad(name, `expected no effect but changed ${x} → ${y}`);
    else ok(name, `no effect, as documented (${x})`);
    return;
  }
  if (mode === "narrows") {
    if (y >= x) bad(name, `did not narrow: ${x} → ${y}`);
    else ok(name, `${x} → ${y}`);
    return;
  }
  if (x === y) bad(name, `no effect: both ${x}`);
  else ok(name, `${x} → ${y}`);
}

console.log(`\nfilters: ${BASE}\n`);

// Real ids, so nothing is hardcoded and the script survives data changes.
const campaigns = await get("/api/analytics/campaigns?preset=90d");
const ebCampaign = (campaigns.rows ?? []).find((r) => r.platform === "emailbison");
const clients = await get("/api/analytics/clients?preset=90d");
const client = (clients.rows ?? []).find((r) => r.clientId);
const mgmt = await get("/api/campaigns?limit=5");
const tags = mgmt.tags ?? [];
const statusCounts = mgmt.statusCounts ?? {};

if (!ebCampaign) bad("fixtures", "no EmailBison campaign found");
if (!client) bad("fixtures", "no client with an id found");

const C = ebCampaign?.campaignId;
const CL = client?.clientId;

console.log("— date range —");
await check("preset 90d → 7d narrows Sent",
  "/api/analytics/kpis?preset=90d", "/api/analytics/kpis?preset=7d", metric.kpiSent);
await check("custom from/to differs from 90d",
  "/api/analytics/kpis?preset=90d",
  "/api/analytics/kpis?preset=custom&from=2026-09-01&to=2026-09-05", metric.kpiSent, "changes");

console.log("\n— campaign & client —");
if (C) {
  await check("campaign_ids narrows Sent",
    "/api/analytics/kpis?preset=90d", `/api/analytics/kpis?preset=90d&campaign_ids=${C}`, metric.kpiSent);
  await check("campaign_ids narrows the campaigns table",
    "/api/analytics/campaigns?preset=90d", `/api/analytics/campaigns?preset=90d&campaign_ids=${C}`, metric.rowCount);
  await check("campaign_ids narrows the chart",
    "/api/analytics/timeseries?preset=90d", `/api/analytics/timeseries?preset=90d&campaign_ids=${C}`, metric.pointsSent);
}
if (CL) {
  await check("client_ids narrows Sent",
    "/api/analytics/kpis?preset=90d", `/api/analytics/kpis?preset=90d&client_ids=${CL}`, metric.kpiSent);
  await check("client_ids narrows the clients table",
    "/api/analytics/clients?preset=90d", `/api/analytics/clients?preset=90d&client_ids=${CL}`, metric.rowCount);
  await check("client_ids narrows Volume",
    "/api/analytics/volume?preset=90d", `/api/analytics/volume?preset=90d&client_ids=${CL}`, metric.volumeTotal);
  await check("client_ids reaches Instantly too",
    "/api/analytics/kpis?preset=90d&platforms=instantly",
    `/api/analytics/kpis?preset=90d&platforms=instantly&client_ids=${CL}`, metric.kpiSent);
}

console.log("\n— platform —");
await check("platforms=emailbison differs from instantly",
  "/api/analytics/kpis?preset=90d&platforms=emailbison",
  "/api/analytics/kpis?preset=90d&platforms=instantly", metric.kpiSent, "changes");
await check("platforms narrows Volume",
  "/api/analytics/volume?preset=90d", "/api/analytics/volume?preset=90d&platforms=instantly", metric.volumeTotal);
await check("platforms narrows the campaigns table",
  "/api/analytics/campaigns?preset=90d&platforms=emailbison,instantly",
  "/api/analytics/campaigns?preset=90d&platforms=emailbison", metric.rowCount);

// The regression that started all of this.
if (C) {
  const a = await get(`/api/analytics/kpis?preset=90d&campaign_ids=${C}&platforms=emailbison`);
  const b = await get(`/api/analytics/kpis?preset=90d&campaign_ids=${C}&platforms=emailbison,instantly`);
  const i = await get(`/api/analytics/kpis?preset=90d&campaign_ids=${C}&platforms=instantly`);
  if (metric.kpiSent(a) !== metric.kpiSent(b)) {
    bad("campaign filter does not leak Instantly",
      `adding Instantly changed ${metric.kpiSent(a)} → ${metric.kpiSent(b)}`);
  } else if (metric.kpiSent(i) !== 0) {
    bad("campaign filter does not leak Instantly", `Instantly alone reports ${metric.kpiSent(i)}, must be 0`);
  } else {
    ok("campaign filter does not leak Instantly", `${metric.kpiSent(a)} sent, Instantly 0`);
  }
}

console.log("\n— compare —");
{
  const withCompare = await get("/api/analytics/kpis?preset=30d&compare=1");
  const without = await get("/api/analytics/kpis?preset=30d");
  if (!withCompare.previous) bad("compare=1 returns a previous period", "no `previous` in the response");
  else if (without.previous) bad("compare is off by default", "`previous` present without compare=1");
  else ok("compare=1 returns a previous period", `sent ${withCompare.previous.sent}`);
}

console.log("\n— volume —");
await check("group=campaign differs from group=client",
  "/api/analytics/volume?preset=90d&group=client",
  "/api/analytics/volume?preset=90d&group=campaign", (j) => (j.rows ?? []).length ? String((j.rows ?? [])[0].label).length : NaN, "changes");
await check("Volume ignores campaign_ids (control is hidden)",
  "/api/analytics/volume?preset=90d",
  `/api/analytics/volume?preset=90d&campaign_ids=${C ?? 1}`, metric.volumeTotal, "inert");

console.log("\n— replies —");
await check("positive=1 narrows the reply set",
  "/api/analytics/replies?preset=90d",
  "/api/analytics/replies?preset=90d&positive=1",
  (j) => (j.breakdowns ?? []).reduce((n, b) => n + Number(b.total ?? 0), 0));

console.log("\n— campaigns management page —");
await check("q= narrows the campaign list",
  "/api/campaigns?limit=500", "/api/campaigns?limit=500&q=nicole", metric.mgmtTotal);
await check("q= with no match returns nothing",
  "/api/campaigns?limit=500", "/api/campaigns?limit=500&q=zzzznomatch", metric.mgmtTotal);
{
  const s = Object.keys(statusCounts).find((k) => Number(statusCounts[k]) > 0);
  if (s) {
    await check(`status=${s} narrows the campaign list`,
      "/api/campaigns?limit=500", `/api/campaigns?limit=500&status=${encodeURIComponent(s)}`, metric.mgmtTotal);
  }
}
if (tags.length) {
  const t = typeof tags[0] === "string" ? tags[0] : tags[0]?.tag ?? tags[0]?.name;
  if (t) {
    await check(`tag filter narrows the campaign list`,
      "/api/campaigns?limit=500", `/api/campaigns?limit=500&tag=${encodeURIComponent(t)}`, metric.mgmtTotal);
  }
}
if (CL) {
  await check("client_id narrows the campaign list",
    "/api/campaigns?limit=500", `/api/campaigns?limit=500&client_id=${CL}`, metric.mgmtTotal);
}

console.log("\n— pagination —");
{
  const page1 = await get("/api/campaigns?limit=5&offset=0");
  const page2 = await get("/api/campaigns?limit=5&offset=5");
  const ids = (j) => (j.items ?? []).map((i) => i.id).join(",");
  if (!(page1.items ?? []).length) bad("offset pages the campaign list", "no items on page 1");
  else if (ids(page1) === ids(page2)) bad("offset pages the campaign list", "page 2 identical to page 1");
  else if (page1.total !== page2.total) bad("total is stable across pages", `${page1.total} vs ${page2.total}`);
  else ok("offset pages the campaign list", `total ${page1.total}, distinct pages`);

  // A filter plus paging is where a JS-side filter used to fall apart.
  const filtered = await get("/api/campaigns?limit=2&offset=0&status=active");
  if ((filtered.items ?? []).length > 2) bad("limit is honoured with a filter", `${filtered.items.length} > 2`);
  else ok("limit is honoured with a filter", `${filtered.items.length} of ${filtered.total}`);
}

console.log("\n— infrastructure —");
await check("estate=instantly differs from emailbison",
  "/api/infrastructure?estate=emailbison&view=domain",
  "/api/infrastructure?estate=instantly&view=domain", (j) => Number(j?.totals?.inboxes ?? NaN), "changes");
await check("view=provider differs from view=domain",
  "/api/infrastructure?estate=emailbison&view=domain",
  "/api/infrastructure?estate=emailbison&view=provider", metric.rowCount, "changes");
await check("view=vendor differs from view=domain",
  "/api/infrastructure?estate=emailbison&view=domain",
  "/api/infrastructure?estate=emailbison&view=vendor", metric.rowCount, "changes");
await check("q= narrows infrastructure rows",
  "/api/infrastructure?estate=emailbison&view=domain",
  "/api/infrastructure?estate=emailbison&view=domain&q=realty", metric.rowCount);
/*
 * These two look interchangeable and are not: min_total gates the TABLE,
 * min_sent gates the "Needs attention" card. Asserting min_sent against the
 * table reported a working filter as broken.
 */
await check("min_total raises the table's floor",
  "/api/infrastructure?estate=emailbison&view=domain&min_total=0",
  "/api/infrastructure?estate=emailbison&view=domain&min_total=1000", metric.rowCount);
await check("min_sent raises the attention card's floor",
  "/api/infrastructure?estate=emailbison&view=domain&min_sent=1",
  "/api/infrastructure?estate=emailbison&view=domain&min_sent=1000000", metric.problems);
await check("rcpt=domain differs from rcpt=esp",
  "/api/infrastructure?estate=emailbison&view=domain&rcpt=esp",
  "/api/infrastructure?estate=emailbison&view=domain&rcpt=domain",
  (j) => String((j.recipients ?? [])[0]?.label ?? "").length || NaN, "changes");

console.log(
  `\n${failures.length ? `${failures.length} FAILED: ${failures.join("; ")}` : "every filter behaves"}\n`,
);
process.exit(failures.length ? 1 : 0);
