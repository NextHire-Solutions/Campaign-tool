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
    must: [/Search campaigns/, /Campaign/, /Sent/],
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

  /** Clicks by real mouse events — a synthetic .click() skips Radix handlers. */
  const clickText = async (label) => {
    const box = await evaluate(`(() => {
      const el = Array.from(document.querySelectorAll('button'))
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

close();
console.log(
  `\n${failures.length ? `${failures.length} FAILED` : "all checks passed"}\n`,
);
process.exit(failures.length ? 1 : 0);
