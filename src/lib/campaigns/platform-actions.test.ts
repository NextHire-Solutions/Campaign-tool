import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CAMPAIGN_ACTIONS, canApply, platformSupports } from "./status.ts";

/*
 * Two questions that look like one. `canApply` is about a campaign's STATUS,
 * `platformSupports` about whether the action exists on the platform at all.
 * Conflating them offers buttons whose calls cannot be made.
 */

test("EmailBison supports every action", () => {
  for (const action of CAMPAIGN_ACTIONS) {
    assert.equal(platformSupports(action, "emailbison"), true, action);
  }
});

test("Instantly supports pause, resume and duplicate", () => {
  assert.equal(platformSupports("pause", "instantly"), true);
  assert.equal(platformSupports("resume", "instantly"), true);
  assert.equal(platformSupports("duplicate", "instantly"), true);
});

test("INSTANTLY HAS NO ARCHIVE", () => {
  /*
   * The one asymmetry. `archived_at` is our own column — it records that a
   * campaign stopped appearing in the API, not something Instantly can be asked
   * to do. Offering it would write a local flag while changing nothing
   * upstream, which is the "shows the change as saved when it wasn't" that
   * spec §9.5 forbids.
   */
  assert.equal(platformSupports("archive", "instantly"), false);
});

test("an unknown platform is treated as EmailBison rather than refused", () => {
  // Fail open here, not closed: the only ids that reach this are ours, and
  // refusing an unrecognised string would break every action on a typo rather
  // than surfacing it.
  assert.equal(platformSupports("archive", "something-else"), true);
});

test("platform support and status eligibility are independent", () => {
  // Instantly supports pause, but a completed campaign still is not pausable —
  // both gates must agree before an action is offered.
  assert.equal(platformSupports("pause", "instantly"), true);
  assert.equal(canApply("pause", "completed"), false);

  // And the converse: archive applies to a non-archived status, yet Instantly
  // still cannot do it.
  assert.equal(canApply("archive", "paused"), true);
  assert.equal(platformSupports("archive", "instantly"), false);
});

test("resume stays restricted to paused on both platforms", () => {
  // The load-bearing rule: resume queues sending, it does not un-hide.
  assert.equal(canApply("resume", "paused"), true);
  assert.equal(canApply("resume", "completed"), false);
  assert.equal(canApply("resume", "draft"), false);
});
