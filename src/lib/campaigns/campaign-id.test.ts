import { strict as assert } from "node:assert";
import { test } from "node:test";
import { platformOfId } from "./campaign-id.ts";

test("a uuid is an Instantly campaign", () => {
  assert.equal(platformOfId("4cb1ce6b-db02-4385-85f5-1ffeecdbb08c"), "instantly");
  assert.equal(platformOfId("4CB1CE6B-DB02-4385-85F5-1FFEECDBB08C"), "instantly");
});

test("a positive integer is an EmailBison campaign", () => {
  assert.equal(platformOfId("55"), "emailbison");
  assert.equal(platformOfId("194"), "emailbison");
});

test("THE TWO SPACES CANNOT COLLIDE", () => {
  // The whole justification for reading platform off the shape: no string is
  // both a valid bigint id and a valid uuid.
  const uuid = "00000000-0000-0000-0000-000000000001";
  assert.notEqual(platformOfId(uuid), platformOfId("1"));
});

test("anything else is null, never a guess", () => {
  // A malformed id must 404 rather than be routed at one platform and reported
  // as "not found" there, which sends someone looking for a sync problem.
  for (const bad of ["", "  ", "0", "-5", "1.5", "abc", "55x", "not-a-uuid"]) {
    assert.equal(platformOfId(bad), null, bad);
  }
});

test("surrounding whitespace does not change the answer", () => {
  assert.equal(platformOfId("  55  "), "emailbison");
});
