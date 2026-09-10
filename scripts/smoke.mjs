#!/usr/bin/env node
/*
 * Page-level smoke test: does every screen actually render its data?
 *
 * WHY THIS EXISTS, IN ONE SENTENCE: a check that asserted "the page returned
 * 200 and has more than 120 characters of text" passed the Infrastructure tab
 * while it was showing "0 domains / Nothing to show" for the entire EmailBison
 * estate. Both facts were true and the page was broken.
 *
 * So every page here declares what it must CONTAIN and what it must NOT. The
 * must-not list is the important half — an empty state is the failure mode that
 * looks like success, and "0 domains" is a string a healthy page never renders.
 *
 * Numbers are asserted as SHAPES (/\d/, "of 1,796"), never as literals. A test
 * that hardcodes today's totals fails every time the data changes, which
 * teaches everyone to ignore it.
 *
 *   node scripts/smoke.mjs                     # against localhost:3000
 *   BASE=https://analytics.brokerstaffer.com node scripts/smoke.mjs
 *
 * Needs a session: SMOKE_TOKEN, or AUTH_SECRET + AUTH_USERS in the environment
 * so one can be minted.
 */

import { createHmac } from "node:crypto";

const BASE = process.env.BASE ?? "http://localhost:3000";
const CDP = process.env.CDP ?? "http://localhost:9222";

/** Every page, what proves it rendered, and what proves it did not. */
const PAGES = [
  {
    path: "/analytics/campaign?preset=30d",
    must: [/Sent/, /Prospects/, /Reply Rate/, /\d/],
    mustNot: [/Could not load/i, /Failed to load/i],
  },
  {
    path: "/analytics/campaign?preset=30d&view=campaigns",
    must: [/Campaign/, /Sent/, /Reply %/],
    // A campaign table with no rows is the empty state, not a working page.
    mustNot: [/No campaigns/i, /Nothing to show/i],
  },
  {
    path: "/analytics/campaign?preset=30d&view=clients",
    must: [/Sent/],
    mustNot: [/Could not load/i],
  },
  {
    path: "/analytics/campaign?preset=30d&view=replies",
    must: [/replies|Replies/],
    mustNot: [/Could not load/i],
  },
  {
    path: "/analytics/volume?preset=30d",
    must: [/Daily sending capacity/, /Where the volume went/, /\d,\d/],
    mustNot: [/Could not load/i, /both platforms · 0\b/],
  },
  {
    path: "/analytics/infrastructure",
    // The exact page that shipped broken. `inboxes sending` only renders when
    // totals arrived; the empty-table copy only renders when they did not.
    //
    // `\b0 domains` needs the word boundary: without it this matched the "30
    // domains" inside a perfectly healthy recipient row and failed a working
    // page. A count assertion has to be anchored or it will find a digit
    // somewhere and be wrong about it.
    must: [/inboxes sending/, /Bounce rate/, /Sending domains by bounce band/, /\d/],
    mustNot: [/\b0 domains\b/, /Run sync-senders/i, /could not be loaded/i],
  },
  /*
   * The Instantly estate is NOT reachable by URL — that toggle is local
   * component state, unlike every filter in the analytics bar. So it is
   * exercised by clicking, below, rather than by a path here. Asserting
   * `?estate=instantly` looked like a second check and silently re-tested the
   * EmailBison page: both returned byte-identical text.
   */
  {
    path: "/analytics/attribution?preset=30d",
    must: [/\w/],
    mustNot: [/Could not load/i],
  },
  {
    path: "/analytics/copy-offer?preset=30d",
    must: [/\w/],
    mustNot: [/Could not load/i],
  },
  {
    path: "/campaigns",
    /*
     * "Instantly" must appear as a row badge, not merely as a filter option:
     * the list spans both platforms now, and a page showing only EmailBison
     * while offering a platform filter is the exact bug this replaced — one
     * that looks completely normal until you count the rows.
     */
    must: [/Search campaigns/, /Campaign/, /Sent/, /Instantly/, /All platforms/],
    mustNot: [/No campaigns found/i],
  },
  { path: "/clients", must: [/\w/], mustNot: [/Could not load/i] },
  { path: "/schedule", must: [/\w/], mustNot: [/Could not load/i] },
];

/** The platform filter must actually move the numbers, not just render. */
const FILTER_CHECKS = [
  {
    name: "platform filter changes the KPI band",
    a: "/analytics/campaign?preset=30d&platforms=emailbison",
    b: "/analytics/campaign?preset=30d&platforms=instantly",
    extract: `(() => {
      const el = Array.from(document.querySelectorAll('*'))
        .find(e => e.children.length === 0 && e.innerText?.trim() === 'Sent');
      return el?.parentElement?.innerText?.replace(/\\n/g, ' ') ?? null;
    })()`,
  },
  {
    name: "platform filter changes the volume total",
    a: "/analytics/volume?preset=30d&platforms=emailbison",
    b: "/analytics/volume?preset=30d&platforms=instantly",
    extract: `(document.body.innerText.match(/[\\d,]+ sent in range/) || [])[0] ?? null`,
  },
];

// --- session ----------------------------------------------------------------

function mintToken() {
  if (process.env.SMOKE_TOKEN) return process.env.SMOKE_TOKEN;
  const secret = process.env.AUTH_SECRET;
  const users = process.env.AUTH_USERS;
  if (!secret || !users) {
    console.error("Need SMOKE_TOKEN, or AUTH_SECRET + AUTH_USERS to mint one.");
    process.exit(2);
  }
  const email = users.split(/[\n,]+/)[0].split(":")[0].trim();
  const payload = `${Buffer.from(email).toString("base64url")}.${Date.now() + 86_400_000}`;
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

// --- CDP --------------------------------------------------------------------

async function connect() {
  const targets = await (await fetch(`${CDP}/json`)).json();
  const target =
    targets.find((t) => t.type === "page") ??
    (await (await fetch(`${CDP}/json/new?about:blank`)).json());

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });

  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    return r.result?.result?.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Network.setCookie", {
    name: "bsa_session",
    value: mintToken(),
    domain: new URL(BASE).hostname,
    path: "/",
  });

  /*
   * Settle on the ABSENCE of every loading affordance, not a fixed sleep.
   * Skeletons matter as much as spinners — the KPI band uses only skeletons,
   * and reading through them is what produced false failures before.
   */
  const goto = async (path) => {
    await send("Page.navigate", { url: BASE + path });
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const ready = await evaluate(`(() => {
        if (document.readyState !== "complete") return false;
        if (document.querySelector('.animate-spin')) return false;
        if (document.querySelector('[data-slot="skeleton"]')) return false;
        return (document.body.innerText || '').trim().length > 0;
      })()`);
      if (ready) return;
    }
  };

  /*
   * Clicks by real mouse events — a synthetic .click() skips Radix handlers.
   *
   * `scope` is not optional decoration. The campaigns view has TWO buttons
   * reading "Replies" (a column header and a sub-view tab); clicking the first
   * match navigated away and left an empty table, which the sort check then
   * read as a successful re-sort. Naming the container is what makes a click
   * unambiguous.
   */
  const clickText = async (label, scope = "button") => {
    const box = await evaluate(`(() => {
      const el = Array.from(document.querySelectorAll(${JSON.stringify(scope)}))
        .find(e => (e.innerText || '').trim() === ${JSON.stringify(label)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) return false;
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", {
        type, x: box.x, y: box.y, button: "left", clickCount: 1,
      });
    }
    await new Promise((r) => setTimeout(r, 2500));
    return true;
  };

  return { evaluate, goto, clickText, close: () => ws.close() };
}

// --- run --------------------------------------------------------------------

const { evaluate, goto, clickText, close } = await connect();
const failures = [];
const pass = (name, detail) => console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
const fail = (name, why) => {
  failures.push(`${name}: ${why}`);
  console.log(`  FAIL ${name} — ${why}`);
};

console.log(`\nsmoke: ${BASE}\n`);

/*
 * innerText PLUS the text that lives in attributes.
 *
 * A placeholder is not in innerText. Asserting on "Search campaigns…" against
 * innerText alone reports a healthy page as broken — a false failure that costs
 * exactly as much trust as a false pass. Placeholders, aria-labels and titles
 * are visible-to-the-user text, so they belong in what a smoke test reads.
 */
const PAGE_TEXT = `(() => {
  const attrs = Array.from(
    document.querySelectorAll('[placeholder],[aria-label],[title]')
  )
    .map((el) => [el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' '))
    .join('\\n');
  return (document.body.innerText || '') + '\\n' + attrs;
})()`;

for (const page of PAGES) {
  await goto(page.path);
  const text = await evaluate(PAGE_TEXT);
  if (!text) {
    fail(page.path, "no text rendered");
    continue;
  }
  const missing = page.must.filter((re) => !re.test(text));
  const forbidden = page.mustNot.filter((re) => re.test(text));
  if (missing.length) fail(page.path, `missing ${missing.join(", ")}`);
  else if (forbidden.length) fail(page.path, `found ${forbidden.join(", ")}`);
  else pass(page.path, `${text.length} chars`);
}

console.log("");
for (const check of FILTER_CHECKS) {
  await goto(check.a);
  const a = await evaluate(check.extract);
  await goto(check.b);
  const b = await evaluate(check.extract);
  if (a === null || b === null) fail(check.name, "could not read the value");
  else if (a === b) fail(check.name, `both read "${a}" — the filter did nothing`);
  else pass(check.name, `"${a}" → "${b}"`);
}

/*
 * The Instantly estate, reached the only way it can be: by clicking.
 *
 * It must render its own numbers AND differ from EmailBison's. Asserting only
 * "it rendered" would pass if the toggle did nothing at all, which is precisely
 * the bug shape worth catching.
 */
console.log("");
await goto("/analytics/infrastructure");
const ebEstate = await evaluate(PAGE_TEXT);
if (!(await clickText("Instantly"))) {
  fail("infrastructure estate toggle", "no Instantly button found");
} else {
  const instEstate = await evaluate(PAGE_TEXT);
  if (!/inboxes sending/.test(instEstate)) {
    fail("infrastructure: Instantly estate", "did not render its totals");
  } else if (instEstate === ebEstate) {
    fail("infrastructure: Instantly estate", "identical to EmailBison — toggle did nothing");
  } else {
    const inboxes = (instEstate.match(/of ([\d,]+) inboxes sending/) ?? [])[1];
    pass("infrastructure: Instantly estate", `${inboxes} inboxes`);
  }
}

/*
 * FILTERS MUST NOT LEAK ACROSS PLATFORMS.
 *
 * The bug: filtering to one EmailBison campaign and ticking Instantly reported
 * 43,283 sent for a campaign that sent 2 — the Instantly queries dropped the
 * campaign filter and returned the whole workspace. Checked through the API
 * because the assertion is about numbers, not pixels.
 *
 * The invariant is arithmetic and cannot be satisfied by accident: with a
 * campaign selected, adding Instantly to the platform filter must not change
 * the total, because no Instantly campaign can be in an EmailBison selection.
 */
/*
 * Both platforms actually rendered, counted on the page rather than the API —
 * an API that returns 501 rows tells you nothing about whether the table drew
 * them.
 */
/*
 * An Instantly campaign's Leads tab, on the rendered page. The API can return
 * 12,080 leads and still leave the tab blank if the component never asked for
 * them, so this asserts on drawn rows.
 */
console.log("");
{
  const cookie = `bsa_session=${mintToken()}`;
  const list = await (await fetch(`${BASE}/api/campaigns?limit=400&platforms=instantly`, { headers: { cookie } })).json();
  let target = null;
  for (const c of (list.items ?? []).slice(0, 30)) {
    const r = await (await fetch(`${BASE}/api/campaigns/${c.id}/leads?page=1`, { headers: { cookie } })).json();
    if (r.total > 0) { target = { c, total: r.total }; break; }
  }
  if (!target) {
    fail("an Instantly campaign has leads", "none of the first 30 had any");
  } else {
    /*
     * NAVIGATE FROM THE LIST, not straight to the URL.
     *
     * This is the check that was missing. The detail page was verified by
     * visiting /campaigns/{uuid} directly and passed — while the list rendered
     * Instantly rows as plain text, because an earlier guard made them
     * non-links when the page could not render them yet. 318 campaigns were
     * visible and unreachable, and every test passed: they all tested the
     * destination, never the path to it.
     */
    await goto("/campaigns?platforms=instantly");
    const href = await evaluate(`(() => {
      const a = Array.from(document.querySelectorAll('a[href^="/campaigns/"]'))
        .find(x => /\\/campaigns\\/[0-9a-f-]{36}$/.test(x.getAttribute('href') || ''));
      return a ? a.getAttribute('href') : null;
    })()`);
    if (!href) {
      fail("Instantly rows link to their campaign", "no uuid link in the list — the rows are not clickable");
    } else {
      pass("Instantly rows link to their campaign", href);
    }

    await goto(`/campaigns/${target.c.id}`);
    /*
     * textContent, not innerText. innerText depends on layout and came back
     * empty for these buttons in headless, so a page that was rendering
     * perfectly reported "no tabs drawn". The page text in the failure message
     * is what showed it — the campaign name and status were right there.
     */
    const tabs = await evaluate(`
      Array.from(document.querySelectorAll('button'))
        .map(b => (b.textContent || '').trim())
        .filter(t => ['Overview','Leads','Sequence','Copy & Offer','Settings','Activity'].includes(t))
    `);
    if (!tabs?.length) {
      const seen = (await evaluate(`document.body.innerText`) || "").slice(0, 160).replace(/\s+/g, " ");
      fail("the Instantly campaign page renders", `no tabs drawn — page reads: ${seen}`);
    }
    else if (tabs.includes("Sequence") || tabs.includes("Settings")) {
      fail("tabs are gated for Instantly", `showed ${tabs.join(", ")}`);
    } else {
      pass("tabs are gated for Instantly", tabs.join(", "));
      await clickText("Leads");
      // The table mounts after its query resolves; a click is not a render.
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 400));
        if (await evaluate(`document.querySelectorAll('table tbody tr').length`)) break;
      }
      const rows = await evaluate(`document.querySelectorAll('table tbody tr').length`);
      if (rows > 0) pass("the Instantly Leads tab draws rows", `${rows} of ${target.total}`);
      else fail("the Instantly Leads tab draws rows", `0 drawn, API says ${target.total}`);
    }
  }
}

console.log("");
{
  await goto("/campaigns");
  const badges = await evaluate(`
    Array.from(document.querySelectorAll('span'))
      .filter(s => (s.textContent || '').trim() === 'Instantly').length
  `);
  const rows = await evaluate(`document.querySelectorAll('table tbody tr').length`);
  if (!rows) fail("campaigns page renders rows", "table is empty");
  else if (!badges) fail("campaigns page shows Instantly rows", `${rows} rows, 0 Instantly badges`);
  else pass("campaigns page shows both platforms", `${rows} rows, ${badges} Instantly`);
}

console.log("");
{
  const cookie = `bsa_session=${mintToken()}`;
  const sent = async (qs) => {
    const r = await fetch(`${BASE}/api/analytics/kpis?${qs}`, { headers: { cookie } });
    if (!r.ok) return null;
    return (await r.json())?.current?.sent ?? null;
  };

  // Pick a real campaign rather than hardcoding one, so this keeps working.
  const list = await fetch(`${BASE}/api/analytics/campaigns?preset=30d`, {
    headers: { cookie },
  });
  const first = (await list.json())?.rows?.find((r) => r.platform === "emailbison");

  if (!first) {
    fail("campaign filter × platform", "no EmailBison campaign to test with");
  } else {
    const base = `preset=30d&campaign_ids=${first.campaignId}`;
    const eb = await sent(`${base}&platforms=emailbison`);
    const both = await sent(`${base}&platforms=emailbison,instantly`);
    const inst = await sent(`${base}&platforms=instantly`);

    if (eb === null || both === null || inst === null) {
      fail("campaign filter × platform", "could not read Sent");
    } else if (both !== eb) {
      fail(
        "campaign filter × platform",
        `adding Instantly changed a campaign-filtered total: ${eb} → ${both} (Instantly leaked in)`,
      );
    } else if (inst !== 0) {
      fail(
        "campaign filter × platform",
        `Instantly alone reports ${inst} for an EmailBison campaign; must be 0`,
      );
    } else {
      pass("campaign filter × platform", `${first.campaignName}: ${eb} sent, no leak`);
    }
  }
}

/*
 * CLIENT-SIDE CONTROLS. These never reach an API — normalize, volume/rates, the
 * series toggles and the table sorts all reshape data already in the browser —
 * so an API check cannot see them at all. They are asserted on what the chart
 * and tables actually render.
 */
console.log("");
{
  /*
   * The Y AXIS ONLY. Collecting every <text> in the svg mixes the date labels
   * in, and those never change — so "rates rescales the axis" compared two
   * strings that were identical for their first 40 visible characters and
   * passed on a difference buried past them. The value axis is the thing these
   * controls actually rescale, so that is what gets compared.
   */
  const chartShape = `(() => {
    const nums = Array.from(document.querySelectorAll('svg text'))
      .map(t => (t.textContent || '').trim())
      .filter(v => /^[\\d.,]+[KM]?%?$/.test(v));
    const paths = Array.from(document.querySelectorAll('svg path'))
      .map(p => (p.getAttribute('d') || '').length).filter(Boolean);
    return { paths: paths.join(','), yAxis: nums.join('|') };
  })()`;

  await goto("/analytics/campaign?preset=30d&view=charts&series=sent");
  const volume = await evaluate(chartShape);
  await goto("/analytics/campaign?preset=30d&view=charts&series=sent&mode=rates");
  const rates = await evaluate(chartShape);
  if (!volume?.paths) fail("chart renders a series", "no path drawn");
  else if (!volume.yAxis) fail("chart draws a value axis", "no numeric ticks");
  else if (volume.yAxis === rates.yAxis) fail("mode=rates rescales the axis", `unchanged: ${volume.yAxis}`);
  else pass("mode=rates rescales the axis", `${volume.yAxis} → ${rates.yAxis}`);

  await goto("/analytics/campaign?preset=30d&view=charts&series=sent,replies&normalize=1");
  const norm = await evaluate(chartShape);
  if (!norm?.yAxis) fail("normalize renders", "no value axis");
  else if (norm.yAxis === volume.yAxis) fail("normalize rescales the axis", `unchanged: ${norm.yAxis}`);
  else pass("normalize rescales the axis", `${volume.yAxis} → ${norm.yAxis}`);

  await goto("/analytics/campaign?preset=30d&view=charts&series=sent");
  const one = await evaluate(chartShape);
  await goto("/analytics/campaign?preset=30d&view=charts&series=sent,replies,bounces");
  const three = await evaluate(chartShape);
  const count = (v) => (v?.paths ? v.paths.split(",").length : 0);
  if (count(three) <= count(one)) fail("series= draws more lines", `${count(one)} → ${count(three)}`);
  else pass("series= draws more lines", `${count(one)} → ${count(three)} paths`);

  await goto("/analytics/campaign?preset=30d&view=charts&series=sent&exclude_weekends=1");
  const noWeekend = await evaluate(`(document.body.innerText.match(/\\b(Sat|Sun)\\b/g) || []).length`);
  if (noWeekend > 0) fail("exclude_weekends hides weekend ticks", `${noWeekend} weekend labels still drawn`);
  else pass("exclude_weekends hides weekend ticks");

  // Sub-views must render different tables, not the same one relabelled.
  const firstRow = `(() => {
    const r = document.querySelector('table tbody tr, [role="row"]');
    return (r?.innerText || '').replace(/\\s+/g, ' ').slice(0, 60);
  })()`;
  await goto("/analytics/campaign?preset=30d&view=clients");
  const clientsRow = await evaluate(firstRow);
  await goto("/analytics/campaign?preset=30d&view=campaigns");
  const campaignsRow = await evaluate(firstRow);
  if (!clientsRow || !campaignsRow) fail("sub-views render rows", `clients="${clientsRow}" campaigns="${campaignsRow}"`);
  else if (clientsRow === campaignsRow) fail("Clients and Campaigns are different tables", "identical first row");
  else pass("Clients and Campaigns are different tables");

  // Table sorting, clicked for real.
  await goto("/analytics/campaign?preset=30d&view=campaigns");
  const before = await evaluate(firstRow);
  const clicked = await clickText("Replies", "th, th button");
  /*
   * Wait for a NON-EMPTY row before comparing. Reading straight after the click
   * caught the table mid-rerender and returned "", which differs from the old
   * row and so reported a pass — a sort that never happened would look
   * identical. An empty row is now an explicit failure.
   */
  let after = "";
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 400));
    after = await evaluate(firstRow);
    if (after) break;
  }
  if (!clicked) fail("clicking a column header sorts", "no Replies header found");
  else if (!after) fail("clicking a column header sorts", "table never re-rendered a row");
  else if (before === after) fail("clicking a column header sorts", "top row unchanged");
  else pass("clicking a column header sorts", `${before.slice(0, 26)} → ${after.slice(0, 26)}`);
}

close();
console.log(
  `\n${failures.length ? `${failures.length} FAILED` : "all checks passed"}\n`,
);
process.exit(failures.length ? 1 : 0);
