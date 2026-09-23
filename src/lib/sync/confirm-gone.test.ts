import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { confirmGone, sampleSize, spread } from "./confirm-gone.ts";

/*
 * The three outcomes this has to get right, in the order they matter:
 *
 *   1. a real mass deletion is archived (the case the old guard refused),
 *   2. a truncated walk is NOT archived (the case the old guard existed for),
 *   3. an unclear failure is NOT archived (we do not guess).
 */

/** Shaped like the API clients' errors: a message and a statusCode. */
function apiError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode });
}
const gone = (id: string) => Promise.reject(apiError(`Instantly 404 on /campaigns/${id}`, 404));
const alive = () => Promise.resolve({ id: "x" });

describe("confirmGone", () => {
  test("archives when every sampled id is really gone", async () => {
    const missing = Array.from({ length: 318 }, (_, i) => `c${i}`);
    const v = await confirmGone(missing, { fetchOne: gone });
    assert.equal(v.archive, true);
    assert.match(v.reason, /confirmed deleted/);
  });

  test("declines the moment one id still resolves — that is a truncated walk", async () => {
    const missing = Array.from({ length: 50 }, (_, i) => `c${i}`);
    const probed = spread(missing, sampleSize(missing.length));
    const v = await confirmGone(missing, {
      fetchOne: (id) => (id === probed[3] ? alive() : gone(id)),
    });
    assert.equal(v.archive, false);
    assert.match(v.reason, /still resolves/);
  });

  /*
   * The honest limit of sampling, written down rather than hidden: a loss that
   * is MOSTLY real deletions with a few truncated rows mixed in can pass, and
   * those few would be archived wrongly. The sample scales with the loss to
   * make that unlikely; it cannot make it impossible without probing all of
   * them, which for 5,000 rows is 5,000 calls an hour.
   */
  test("sampling scales with the size of the loss", () => {
    assert.equal(sampleSize(10), 8);
    assert.equal(sampleSize(318), 16);
    assert.equal(sampleSize(5000), 25);
  });

  test("a live row inside the sample is always caught, wherever it sits", async () => {
    const missing = Array.from({ length: 318 }, (_, i) => `c${i}`);
    const probed = spread(missing, sampleSize(missing.length));
    for (const live of [probed[0], probed[Math.floor(probed.length / 2)], probed.at(-1)!]) {
      const v = await confirmGone(missing, {
        fetchOne: (id) => (id === live ? alive() : gone(id)),
      });
      assert.equal(v.archive, false, `a live row at ${live} was not caught`);
    }
  });

  test("declines on any error that is not a clean 404", async () => {
    for (const status of [500, 429, 403, undefined]) {
      const v = await confirmGone(["a", "b"], {
        fetchOne: () => Promise.reject(
          status ? apiError("boom", status) : new Error("socket reset"),
        ),
      });
      assert.equal(v.archive, false, `status ${status} should not archive`);
      assert.match(v.reason, /cannot tell deleted from unreachable/);
    }
  });

  test("a network error is never read as a deletion", async () => {
    const v = await confirmGone(["a"], { fetchOne: () => Promise.reject(new Error("ECONNRESET")) });
    assert.equal(v.archive, false);
  });

  test("nothing missing is not a reason to archive", async () => {
    const v = await confirmGone([], { fetchOne: alive });
    assert.equal(v.archive, false);
  });

  test("probes are capped, so a huge deletion costs a handful of calls", async () => {
    let calls = 0;
    const missing = Array.from({ length: 5000 }, (_, i) => `c${i}`);
    await confirmGone(missing, {
      fetchOne: (id) => { calls++; return gone(id); },
    });
    assert.equal(calls, sampleSize(missing.length));
  });

  test("the sample is spread across the list, not the first few", () => {
    const picked = spread(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"], 5);
    assert.deepEqual(picked, ["a", "c", "e", "g", "i"]);
    // Taking the first five would miss a truncation that drops the tail.
    assert.notDeepEqual(picked, ["a", "b", "c", "d", "e"]);
  });

  test("a list shorter than the sample is checked in full", () => {
    assert.deepEqual(spread(["a", "b"], 8), ["a", "b"]);
  });
});
