import { test } from "node:test";
import assert from "node:assert/strict";
import { isUnsupportedInstantly, unsupportedTagIds } from "./mail-servers.ts";

test("EmailBison: exactly the five unsupported tags are picked, by name", () => {
  const tags = [
    { id: 13, name: "Google" }, { id: 14, name: "Outlook" }, { id: 15, name: "Zoho" }, { id: 16, name: "Custom Mail Server" },
    { id: 17, name: "Proofpoint" }, { id: 18, name: "Mimecast" }, { id: 19, name: "Barracuda" }, { id: 30, name: "Sophos" }, { id: 31, name: "Outlook Gov" },
  ];
  const { found, missing } = unsupportedTagIds(tags);
  assert.deepEqual(found.map((t) => t.id).sort((a, b) => a - b), [15, 16, 17, 18, 19]);
  assert.deepEqual(missing, []);
});

test("EmailBison: a tag that does not exist is reported, never guessed", () => {
  const { found, missing } = unsupportedTagIds([{ id: 18, name: "Mimecast" }]);
  assert.deepEqual(found.map((t) => t.name), ["Mimecast"]);
  assert.deepEqual(missing, ["Proofpoint", "Barracuda", "Zoho", "Custom Mail Server"]);
});

test("Instantly: Zoho (3) and Other (999) are unsupported; Google, Microsoft and not-yet-detected are kept", () => {
  assert.equal(isUnsupportedInstantly(3), true);
  assert.equal(isUnsupportedInstantly(999), true);
  for (const c of [1, 2, 0, null, undefined, 9]) assert.equal(isUnsupportedInstantly(c as number | null | undefined), false, String(c));
});
