import { test } from "node:test";
import assert from "node:assert/strict";
import { EmailBisonApiError, invalidIndices } from "./errors.ts";

/*
 * Pinned against the real 422 body observed on
 * DELETE /api/campaigns/141/leads (2026-09-09) when one of three ids was not
 * attached to the campaign. That DELETE is all-or-nothing, so parsing these
 * indices is what stops one stale id failing a batch of 500.
 */

const refusal = (errors: Record<string, string[]>) =>
  new EmailBisonApiError("EmailBison 422 Unprocessable Content", 422, {
    data: { success: false, message: "The selected lead_ids.2 is invalid.", errors },
  });

test("reads the rejected index out of the real 422 body", () => {
  const error = refusal({ "lead_ids.2": ["The selected lead_ids.2 is invalid."] });
  assert.deepEqual(invalidIndices(error, "lead_ids"), [2]);
});

test("several rejected ids come back sorted", () => {
  const error = refusal({
    "lead_ids.7": ["invalid"],
    "lead_ids.0": ["invalid"],
    "lead_ids.3": ["invalid"],
  });
  assert.deepEqual(invalidIndices(error, "lead_ids"), [0, 3, 7]);
});

test("a different field is not matched", () => {
  // The field name is anchored, so sender_email_ids errors cannot be mistaken
  // for lead ones when both appear on the same response.
  const error = refusal({ "sender_email_ids.1": ["invalid"] });
  assert.deepEqual(invalidIndices(error, "lead_ids"), []);
  assert.deepEqual(invalidIndices(error, "sender_email_ids"), [1]);
});

test("a non-indexed validation error yields nothing", () => {
  // "The lead ids field is required" names no index; there is nothing to drop,
  // and guessing would retry a batch that cannot succeed.
  const error = refusal({ lead_ids: ["The lead ids field is required."] });
  assert.deepEqual(invalidIndices(error, "lead_ids"), []);
});

test("unrelated errors are safe", () => {
  assert.deepEqual(invalidIndices(new Error("network down"), "lead_ids"), []);
  assert.deepEqual(invalidIndices(null, "lead_ids"), []);
  assert.deepEqual(
    invalidIndices(new EmailBisonApiError("boom", 500, "not json"), "lead_ids"),
    [],
  );
});

test("an unwrapped body (no data envelope) still parses", () => {
  const error = new EmailBisonApiError("422", 422, {
    errors: { "lead_ids.4": ["invalid"] },
  });
  assert.deepEqual(invalidIndices(error, "lead_ids"), [4]);
});
