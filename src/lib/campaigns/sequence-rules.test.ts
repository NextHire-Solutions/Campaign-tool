import { test } from "node:test";
import assert from "node:assert/strict";
import { stepPermissions, type RuleStep } from "./sequence-rules.ts";

const seq: RuleStep[] = [
  { key: "1", isVariant: false, parentKey: null, sent: 132, active: true },
  { key: "1a", isVariant: true, parentKey: "1", sent: 130, active: true },
  { key: "1b", isVariant: true, parentKey: "1", sent: 0, active: true },
  { key: "2", isVariant: false, parentKey: null, sent: 0, active: true },
];

test("never-sent steps and variants can be deleted", () => {
  assert.equal(stepPermissions("emailbison", "active", seq, "1b").canDelete, true);
  assert.equal(stepPermissions("emailbison", "active", seq, "2").canDelete, true);
});

test("a step that has sent cannot be deleted — it is turned off instead", () => {
  const p = stepPermissions("emailbison", "active", seq, "1");
  assert.equal(p.canDelete, false);
  assert.match(p.deleteWhy ?? "", /turn it off/);
});

test("EmailBison turns off only while paused; Instantly any time", () => {
  assert.equal(stepPermissions("emailbison", "active", seq, "1a").canToggle, false);
  assert.match(stepPermissions("emailbison", "active", seq, "1a").toggleWhy ?? "", /Pause the campaign first/);
  assert.equal(stepPermissions("emailbison", "paused", seq, "1a").canToggle, true);
  assert.equal(stepPermissions("instantly", "active", seq, "1a").canToggle, true);
});

test("a main step with variants is deleted only after its variants", () => {
  const s: RuleStep[] = [
    { key: "1", isVariant: false, parentKey: null, sent: 0, active: true },
    { key: "1b", isVariant: true, parentKey: "1", sent: 0, active: true },
    { key: "2", isVariant: false, parentKey: null, sent: 0, active: true },
  ];
  assert.equal(stepPermissions("emailbison", "draft", s, "1").deleteWhy, "Delete its variants first.");
});

test("the last step cannot be deleted", () => {
  const s: RuleStep[] = [{ key: "1", isVariant: false, parentKey: null, sent: 0, active: true }];
  assert.equal(stepPermissions("emailbison", "draft", s, "1").deleteWhy, "A campaign needs at least one step.");
});

test("unknown sends: deletable only on a draft", () => {
  const s: RuleStep[] = [
    { key: "1", isVariant: false, parentKey: null, sent: null, active: true },
    { key: "2", isVariant: false, parentKey: null, sent: null, active: true },
  ];
  assert.equal(stepPermissions("instantly", "draft", s, "2").canDelete, true);
  assert.equal(stepPermissions("instantly", "active", s, "2").canDelete, false);
});

test("a step that no longer exists is refused", () => {
  assert.equal(stepPermissions("emailbison", "paused", seq, "999").canDelete, false);
});
