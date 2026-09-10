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
  breakdownTotal: (j) => (j?.breakdowns ?? []).reduce((n, b) => n + Number(b.total ?? 0), 0),
  replyRows: (j) => Number(j?.total ?? NaN),
  firstLabel: (j) => String((j?.rows ?? [])[0]?.label ?? (j?.rows ?? [])[0]?.domain ?? ""),
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

console.log("\n— data integrity —");
/*
 * The daily series and the per-campaign lifetime counters are two INDEPENDENT
 * reads of the same platform, so they must agree. They did not: the series held
 * 96,055 sends against a lifetime of 789,679, because the sync only ever walked
 * back 45 days from today and nothing said so on screen. A 90-day view returned
 * 45 days of data and looked complete.
 *
 * Asserted as a ratio rather than equality — the lifetime counters move as
 * Instantly revises them, and a test that demands an exact match would fail on
 * ordinary drift and get ignored.
 */
{
  const lifetimeRow = await get("/api/analytics/campaigns?preset=90d&platforms=instantly");
  const series = await get("/api/analytics/volume?preset=90d&platforms=instantly");
  const windowed = Number(series?.total ?? 0);
  if (!windowed) {
    bad("Instantly daily series has history", "90-day window is empty");
  } else {
    // 90 days of a platform running most of the year should be a large share of
    // the year, not a rounding error. Before the backfill this was 12%.
    const lifetime = (lifetimeRow.rows ?? []).reduce((n, r) => n + Number(r.sent ?? 0), 0);
    const share = lifetime ? windowed / lifetime : 0;
    if (share < 0.5) bad("Instantly 90d covers a real span", `only ${(share * 100).toFixed(0)}% of the 90d table`);
    else ok("Instantly daily series has real history", `90d = ${windowed.toLocaleString()}`);
  }
}

console.log("\n— chart controls (server-side) —");
/*
 * exclude_weekends is applied in SQL, not in the chart component, so it is
 * checkable here. normalize / mode / series are client-side and belong to the
 * browser pass in smoke.mjs.
 */
{
  const a = await get("/api/analytics/timeseries?preset=30d");
  const b = await get("/api/analytics/timeseries?preset=30d&exclude_weekends=1");
  const days = (j) => (j.points ?? []).length;
  if (days(b) >= days(a)) bad("exclude_weekends drops weekend days", `${days(a)} → ${days(b)}`);
  else ok("exclude_weekends drops weekend days", `${days(a)} → ${days(b)} days`);
}

console.log("\n— reply facets & drill-down —");
{
  const facets = await get("/api/analytics/replies/facets?preset=90d");
  for (const [key, param] of [
    ["company", "reply_company"],
    ["location", "reply_location"],
    ["sales_volume", "reply_sales_volume"],
  ]) {
    const v = (facets?.facets?.[key] ?? [])[0]?.value;
    if (!v) { bad(`${param} narrows replies`, "no facet value offered"); continue; }
    await check(`${param} narrows replies`,
      "/api/analytics/replies?preset=90d",
      `/api/analytics/replies?preset=90d&${param}=${encodeURIComponent(v)}`,
      metric.breakdownTotal);
  }

  // The drill-down: clicking a bar must narrow the list to that bucket.
  const cards = await get("/api/analytics/replies?preset=90d");
  const dim = (cards.breakdowns ?? []).find((b) => (b.rows ?? []).length);
  const val = dim?.rows?.[0]?.value;
  if (dim && val) {
    await check(`dimension=${dim.key} drill narrows the reply list`,
      "/api/analytics/replies/rows?preset=90d",
      `/api/analytics/replies/rows?preset=90d&dimension=${encodeURIComponent(dim.key)}&value=${encodeURIComponent(val)}`,
      metric.replyRows);
  } else {
    bad("reply drill-down", "no dimension with rows to drill into");
  }

  await check("q= narrows the reply list",
    "/api/analytics/replies/rows?preset=90d",
    "/api/analytics/replies/rows?preset=90d&q=zzzznomatch", metric.replyRows);

  // Paging the reply list.
  const p1 = await get("/api/analytics/replies/rows?preset=90d&page=1");
  const p2 = await get("/api/analytics/replies/rows?preset=90d&page=2");
  const ids1 = (p1.rows ?? []).map((r) => r.id ?? r.reply_id).join(",");
  const ids2 = (p2.rows ?? []).map((r) => r.id ?? r.reply_id).join(",");
  if (!ids1) bad("page= pages the reply list", "no rows on page 1");
  else if (ids1 === ids2) bad("page= pages the reply list", "page 2 identical to page 1");
  else ok("page= pages the reply list", `${p1.total} replies, distinct pages`);
}

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

console.log("\n— campaigns page spans both platforms —");
{
  const all = await get("/api/campaigns?limit=1");
  const eb = await get("/api/campaigns?limit=1&platforms=emailbison");
  const inst = await get("/api/campaigns?limit=1&platforms=instantly");
  const n = (j) => Number(j?.total ?? NaN);
  if (!n(inst)) {
    bad("Instantly campaigns are listed", "the Instantly-only list is empty");
  } else if (n(eb) + n(inst) !== n(all)) {
    bad("the two platforms partition the list", `${n(eb)} + ${n(inst)} != ${n(all)}`);
  } else {
    ok("the two platforms partition the list", `${n(eb)} + ${n(inst)} = ${n(all)}`);
  }

  // A row must say which platform it belongs to: the id alone is ambiguous
  // across a bigint and a uuid, and the available actions differ.
  const row = (await get("/api/campaigns?limit=1&platforms=instantly")).items?.[0];
  if (row?.platform === "instantly" && typeof row.id === "string") {
    ok("rows carry platform and a string id", `${String(row.id).slice(0, 8)}…`);
  } else {
    bad("rows carry platform and a string id", JSON.stringify({ platform: row?.platform, id: typeof row?.id }));
  }

  // Instantly's integer status must arrive translated, not raw.
  const statuses = new Set(((await get("/api/campaigns?limit=400&platforms=instantly")).items ?? []).map((r) => r.status));
  const numeric = [...statuses].filter((v) => /^-?\d+$/.test(String(v)));
  if (numeric.length) bad("Instantly status is translated", `raw codes leaked: ${numeric.join(", ")}`);
  else ok("Instantly status is translated", [...statuses].join(", "));
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
/*
 * Asserted on the ORDER ITSELF, not on a proxy. This first compared the length
 * of the top label, which two different domains can share — a check that can
 * pass by coincidence is not a check.
 */
{
  const desc = await get("/api/infrastructure?estate=emailbison&view=domain&sort=sent&dir=desc");
  const asc = await get("/api/infrastructure?estate=emailbison&view=domain&sort=sent&dir=asc");
  const sents = (j) => (j.rows ?? []).map((r) => Number(r.sent ?? 0));
  const d = sents(desc), a = sents(asc);
  const sortedDesc = d.every((v, i) => i === 0 || d[i - 1] >= v);
  const sortedAsc = a.every((v, i) => i === 0 || a[i - 1] <= v);
  if (!d.length) bad("sort=sent orders infrastructure rows", "no rows");
  else if (!sortedDesc) bad("sort=sent&dir=desc is actually descending", `top: ${d.slice(0, 3).join(", ")}`);
  else if (!sortedAsc) bad("sort=sent&dir=asc is actually ascending", `top: ${a.slice(0, 3).join(", ")}`);
  else if (d[0] === a[0] && d.length > 1) bad("dir flips the order", `both start at ${d[0]}`);
  else ok("sort=sent honours dir", `desc starts ${d[0]}, asc starts ${a[0]}`);
}
await check("rcpt=domain differs from rcpt=esp",
  "/api/infrastructure?estate=emailbison&view=domain&rcpt=esp",
  "/api/infrastructure?estate=emailbison&view=domain&rcpt=domain",
  (j) => String((j.recipients ?? [])[0]?.label ?? "").length || NaN, "changes");

console.log(
  `\n${failures.length ? `${failures.length} FAILED: ${failures.join("; ")}` : "every filter behaves"}\n`,
);
process.exit(failures.length ? 1 : 0);
