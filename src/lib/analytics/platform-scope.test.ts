import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  coveredPlatforms,
  resolvePlatformScope,
} from "./platform-scope.ts";

/*
 * The regression these lock down: a campaign filter plus Instantly reported the
 * whole Instantly workspace as if it belonged to the selected campaign.
 */

test("no platform filter means EmailBison, not both", () => {
  const scope = resolvePlatformScope({ platforms: [], campaignIds: [] });
  assert.equal(scope.emailbison, true);
  assert.equal(scope.instantly, false);
});

test("asking for both gets both", () => {
  const scope = resolvePlatformScope({
    platforms: ["emailbison", "instantly"],
    campaignIds: [],
  });
  assert.deepEqual(coveredPlatforms(scope), ["emailbison", "instantly"]);
});

test("Instantly alone excludes EmailBison", () => {
  const scope = resolvePlatformScope({ platforms: ["instantly"], campaignIds: [] });
  assert.equal(scope.emailbison, false);
  assert.equal(scope.instantly, true);
});

test("A CAMPAIGN FILTER EXCLUDES INSTANTLY ENTIRELY", () => {
  // The whole point. Campaign ids are EmailBison integers, so no Instantly
  // campaign is in the selection — and the answer is zero rows, never all of
  // them.
  const scope = resolvePlatformScope({ platforms: ["instantly"], campaignIds: [55] });
  assert.equal(scope.instantly, false);
  assert.equal(scope.instantlyExcludedBy, "campaign-filter");
});

test("a campaign filter with both platforms keeps EmailBison and drops Instantly", () => {
  const scope = resolvePlatformScope({
    platforms: ["emailbison", "instantly"],
    campaignIds: [55],
  });
  assert.equal(scope.emailbison, true);
  assert.equal(scope.instantly, false);
  assert.deepEqual(coveredPlatforms(scope), ["emailbison"]);
});

test("a campaign filter alone is unaffected — Instantly was never asked for", () => {
  const scope = resolvePlatformScope({ platforms: [], campaignIds: [55] });
  assert.equal(scope.emailbison, true);
  assert.equal(scope.instantly, false);
  assert.equal(scope.instantlyExcludedBy, undefined);
});

test("the exclusion is only reported when Instantly was actually requested", () => {
  const scope = resolvePlatformScope({
    platforms: ["emailbison"],
    campaignIds: [55],
  });
  assert.equal(scope.instantlyExcludedBy, undefined);
});

test("many campaign ids behave like one", () => {
  const scope = resolvePlatformScope({
    platforms: ["instantly"],
    campaignIds: [55, 194, 7],
  });
  assert.equal(scope.instantly, false);
});

test("coveredPlatforms reports nothing when nothing is in scope", () => {
  const scope = resolvePlatformScope({ platforms: ["instantly"], campaignIds: [1] });
  assert.deepEqual(coveredPlatforms(scope), []);
});
