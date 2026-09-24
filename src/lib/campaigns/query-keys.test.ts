import { strict as assert } from "node:assert";
import { test } from "node:test";
import { campaignKey } from "./query-keys.ts";

test("a number and a string id produce the SAME key", () => {
  // The whole point. React Query compares keys structurally, so before this
  // builder existed `["campaign", 276]` (from a campaign row) and
  // `["campaign", "276"]` (from the route param) were different queries and an
  // invalidation from the Settings tab matched nothing.
  assert.deepEqual(campaignKey(276), campaignKey("276"));
});

test("the id is always the string form the detail query registers under", () => {
  assert.deepEqual(campaignKey(276), ["campaign", "276"]);
  assert.deepEqual(campaignKey("276"), ["campaign", "276"]);
});

test("an Instantly uuid is unchanged", () => {
  const uuid = "4cb1ce6b-db02-4385-85f5-1ffeecdbb08c";
  assert.deepEqual(campaignKey(uuid), ["campaign", uuid]);
});

test("the key stays prefixed so invalidating [\"campaign\"] still matches all", () => {
  // bulk-deploy invalidates the bare prefix to refresh every open campaign.
  // That relies on "campaign" being element 0 and the id element 1.
  assert.equal(campaignKey(1)[0], "campaign");
  assert.equal(campaignKey(1).length, 2);
});
