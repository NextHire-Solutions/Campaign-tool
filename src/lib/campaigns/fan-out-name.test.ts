import { test } from "node:test";
import assert from "node:assert/strict";
import { renderName } from "./fan-out-name.ts";

/*
 * The naming rule for one-template-many-clients.
 *
 * The property that matters: N clients must never produce N identical names.
 * Campaigns are identified by name everywhere in this product — in every list,
 * in the client filter, and in the auto attribution that reads the client out
 * of the campaign name — so duplicates would be indistinguishable.
 */

test("substitutes the client wherever the token appears", () => {
  assert.equal(renderName("{client} + Nicole + SOCAL", "Howe Realty"),
    "Howe Realty + Nicole + SOCAL");
  assert.equal(renderName("Q3 push — {client}", "Kelly + Co"), "Q3 push — Kelly + Co");
});

test("every token is replaced, not just the first", () => {
  assert.equal(renderName("{client} follow-up ({client})", "LIV Indy"),
    "LIV Indy follow-up (LIV Indy)");
});

test("a template with no token still yields distinct names", () => {
  // This is the safety net. Without it a template of "Q3 push" would create
  // five campaigns all called "Q3 push".
  assert.equal(renderName("Q3 push", "Howe Realty"), "Howe Realty — Q3 push");
  assert.notEqual(renderName("Q3 push", "A"), renderName("Q3 push", "B"));
});

test("client names containing the separator survive", () => {
  // "Kelly + Co" is a real client; nothing here may split on the separator.
  assert.equal(renderName("{client} + Nicole", "Kelly + Co"), "Kelly + Co + Nicole");
});

test("surrounding whitespace is trimmed", () => {
  assert.equal(renderName("  {client} push  ", "Howe"), "Howe push");
});
