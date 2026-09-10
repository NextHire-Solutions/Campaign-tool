#!/usr/bin/env node
/*
 * Verifies the Instantly WRITE methods against disposable campaigns.
 *
 * OPT-IN, and deliberately not part of `npm test`: it creates and deletes real
 * campaigns in the live workspace. Two rules make that safe, and both are
 * load-bearing rather than cautious:
 *
 *   - `activate` is never called, and the client has no such method. An
 *     activated campaign emails thousands of real people, and no verification
 *     is worth that risk.
 *   - Everything created is deleted in a `finally`, so a failure halfway
 *     through still cleans up after itself. A leftover campaign in a client
 *     workspace is the kind of mess that outlives the person who made it.
 *
 *   npm run verify:instantly
 */

import { readFileSync } from "node:fs";

// Loads .env.local the way the app does, so this runs with no extra setup.
try {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of env.split("\n")) {
    if (!line.includes("=") || line.trimStart().startsWith("#")) continue;
    const key = line.slice(0, line.indexOf("=")).trim();
    if (!process.env[key]) {
      process.env[key] = line.slice(line.indexOf("=") + 1).replace(/^["']|["']$/g, "");
    }
  }
} catch {
  // The environment may already carry them (CI).
}

const { createInstantlyClient } = await import("../src/lib/instantly/client.ts");

const client = createInstantlyClient();
const MARK = "ZZZ-CLIENT-VERIFY";

let passed = 0;
let failed = 0;
const ok = (name, detail = "") => {
  passed++;
  console.log(`  ok    ${name}${detail ? ` — ${detail}` : ""}`);
};
const no = (name, why) => {
  failed++;
  console.log(`  FAIL  ${name} — ${why}`);
};

let a = null;
let b = null;

console.log("\ninstantly writes: live workspace, disposable campaigns\n");

try {
  const quota = await client.getLeadQuota();
  ok(
    "getLeadQuota",
    `limit=${quota.limit.toLocaleString()} used=${quota.used.toLocaleString()} remaining=${quota.remaining}`,
  );
  if (quota.remaining === 0) {
    console.log(
      "        note: the workspace is over its lead limit, so adding leads is refused.\n" +
        "        That is a billing state, not a bug — see docs/instantly-api-findings.md.",
    );
  }

  a = (await client.createCampaign({ name: `${MARK} A` })).id;
  ok("createCampaign", a);

  const read = await client.getCampaign(a);
  if (String(read?.name ?? "").startsWith(MARK)) ok("getCampaign", String(read.name));
  else no("getCampaign", `unexpected name: ${String(read?.name)}`);

  await client.updateCampaign(a, { name: `${MARK} A renamed` });
  const renamed = await client.getCampaign(a);
  if (renamed.name === `${MARK} A renamed`) ok("updateCampaign (rename)");
  else no("updateCampaign", `name is ${String(renamed.name)}`);

  const accounts = await client.getAllAccounts();
  const email = accounts[0]?.email;
  if (!email) {
    no("setCampaignInboxes", "no Instantly accounts to assign");
  } else {
    await client.setCampaignInboxes(a, [email]);
    const assigned = await client.getCampaignInboxes(a);
    if (assigned.includes(email)) ok("setCampaignInboxes + getCampaignInboxes", email);
    else no("setCampaignInboxes", `read back ${JSON.stringify(assigned)}`);

    await client.setCampaignInboxes(a, []);
    const cleared = await client.getCampaignInboxes(a);
    if (cleared.length === 0) ok("setCampaignInboxes (clear)");
    else no("setCampaignInboxes (clear)", `still ${cleared.length} assigned`);
  }

  const leads = await client.listCampaignLeads(a);
  if (Array.isArray(leads)) ok("listCampaignLeads", `${leads.length} leads`);
  else no("listCampaignLeads", "did not return an array");

  await client.pauseCampaign(a);
  ok("pauseCampaign");

  b = (await client.duplicateCampaign(a)).id;
  const dup = await client.getCampaign(b);
  const steps = dup?.sequences?.[0]?.steps?.length ?? 0;
  ok("duplicateCampaign", `${b} (${steps} step(s), 0 leads by design)`);

  /*
   * ORDER MATTERS HERE. `/leads/move` starts an ASYNCHRONOUS job and locks the
   * campaign while it runs: any add or remove against it answers 409 "There is
   * a move-leads job in progress". Running remove first is not tidiness, it is
   * the only order that can pass — and the lock is the reason a re-campaign
   * built on move cannot immediately touch the same campaign again.
   */
  await client.removeLeads(a, []);
  ok("removeLeads", "accepted with an empty id list");

  await client.moveCampaignLeads(a, b);
  ok("moveCampaignLeads", "accepted (async; locks the campaign until it finishes)");
} catch (error) {
  no("unexpected", error instanceof Error ? error.message : String(error));
} finally {
  /*
   * Cleanup RETRIES, because delete is blocked by the same move-leads lock as
   * everything else. The first version tried once, hit the 409 and left a test
   * campaign sitting in the client's live workspace — exactly the mess this
   * block exists to prevent.
   */
  for (const id of [a, b]) {
    if (!id) continue;
    let removed = false;
    let lastError = "";
    for (let attempt = 0; attempt < 6 && !removed; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 10_000));
      try {
        await client.deleteCampaign(id);
        removed = true;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    if (removed) console.log(`  cleanup deleteCampaign ${id}`);
    else {
      console.log(`  CLEANUP FAILED ${id}: ${lastError}\n  ^ remove this campaign by hand.`);
      failed++;
    }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}
