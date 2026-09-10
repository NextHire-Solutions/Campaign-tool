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
  const scope = resolvePlatformScope({ platforms: [], emailbisonCampaignIds: [], instantlyCampaignIds: [] });
  assert.equal(scope.emailbison, true);
  assert.equal(scope.instantly, false);
});

test("asking for both gets both", () => {
  const scope = resolvePlatformScope({
    platforms: ["emailbison", "instantly"],
    emailbisonCampaignIds: [], instantlyCampaignIds: [],
  });
  assert.deepEqual(coveredPlatforms(scope), ["emailbison", "instantly"]);
});

test("Instantly alone excludes EmailBison", () => {
  const scope = resolvePlatformScope({ platforms: ["instantly"], emailbisonCampaignIds: [], instantlyCampaignIds: [] });
  assert.equal(scope.emailbison, false);
  assert.equal(scope.instantly, true);
});

test("A CAMPAIGN FILTER EXCLUDES INSTANTLY ENTIRELY", () => {
  // The whole point. Campaign ids are EmailBison integers, so no Instantly
  // campaign is in the selection — and the answer is zero rows, never all of
  // them.
  const scope = resolvePlatformScope({ platforms: ["instantly"], emailbisonCampaignIds: [55], instantlyCampaignIds: [] });
  assert.equal(scope.instantly, false);
  assert.equal(scope.instantlyExcludedBy, "campaign-filter");
});

test("a campaign filter with both platforms keeps EmailBison and drops Instantly", () => {
  const scope = resolvePlatformScope({
    platforms: ["emailbison", "instantly"],
    emailbisonCampaignIds: [55], instantlyCampaignIds: [],
  });
  assert.equal(scope.emailbison, true);
  assert.equal(scope.instantly, false);
  assert.deepEqual(coveredPlatforms(scope), ["emailbison"]);
});

test("a campaign filter alone is unaffected — Instantly was never asked for", () => {
  const scope = resolvePlatformScope({ platforms: [], emailbisonCampaignIds: [55], instantlyCampaignIds: [] });
  assert.equal(scope.emailbison, true);
  assert.equal(scope.instantly, false);
  assert.equal(scope.instantlyExcludedBy, undefined);
});

test("the exclusion is only reported when Instantly was actually requested", () => {
  const scope = resolvePlatformScope({
    platforms: ["emailbison"],
    emailbisonCampaignIds: [55], instantlyCampaignIds: [],
  });
  assert.equal(scope.instantlyExcludedBy, undefined);
});

test("many campaign ids behave like one", () => {
  const scope = resolvePlatformScope({
    platforms: ["instantly"],
    emailbisonCampaignIds: [55, 194, 7], instantlyCampaignIds: [],
  });
  assert.equal(scope.instantly, false);
});

test("coveredPlatforms reports nothing when nothing is in scope", () => {
  const scope = resolvePlatformScope({ platforms: ["instantly"], emailbisonCampaignIds: [1], instantlyCampaignIds: [] });
  assert.deepEqual(coveredPlatforms(scope), []);
});

test("SELECTING AN INSTANTLY CAMPAIGN PUTS INSTANTLY IN SCOPE", () => {
  /*
   * The picker offers both platforms now. The old rule excluded Instantly from
   * any campaign filter, because the filter could only hold integers — true
   * then, and wrong now. What it stood in for is this: a platform is in scope
   * only if the selection contains one of ITS campaigns.
   */
  const scope = resolvePlatformScope({
    platforms: ["instantly"],
    emailbisonCampaignIds: [],
    instantlyCampaignIds: ["4cb1ce6b-db02-4385-85f5-1ffeecdbb08c"],
  });
  assert.equal(scope.instantly, true);
  assert.equal(scope.instantlyExcludedBy, undefined);
});

test("a mixed selection keeps both platforms in scope", () => {
  const scope = resolvePlatformScope({
    platforms: ["emailbison", "instantly"],
    emailbisonCampaignIds: [55],
    instantlyCampaignIds: ["4cb1ce6b-db02-4385-85f5-1ffeecdbb08c"],
  });
  assert.deepEqual(coveredPlatforms(scope), ["emailbison", "instantly"]);
});

test("selecting only Instantly campaigns drops EmailBison", () => {
  // The mirror of the original bug: EmailBison must not contribute its whole
  // workspace just because none of its campaigns were picked.
  const scope = resolvePlatformScope({
    platforms: ["emailbison", "instantly"],
    emailbisonCampaignIds: [],
    instantlyCampaignIds: ["4cb1ce6b-db02-4385-85f5-1ffeecdbb08c"],
  });
  assert.equal(scope.emailbison, false);
  assert.equal(scope.instantly, true);
});

test("PICKING AN INSTANTLY CAMPAIGN IS ASKING FOR INSTANTLY", () => {
  /*
   * An empty platform filter means EmailBison, so without this rule selecting
   * an Instantly campaign and nothing else scoped to NEITHER platform — an
   * empty dashboard produced by a filter the user had just set. Naming a
   * campaign is the more specific request.
   */
  const scope = resolvePlatformScope({
    platforms: [],
    emailbisonCampaignIds: [],
    instantlyCampaignIds: ["4cb1ce6b-db02-4385-85f5-1ffeecdbb08c"],
  });
  assert.equal(scope.instantly, true);
  assert.equal(scope.emailbison, false);
  assert.deepEqual(coveredPlatforms(scope), ["instantly"]);
});
