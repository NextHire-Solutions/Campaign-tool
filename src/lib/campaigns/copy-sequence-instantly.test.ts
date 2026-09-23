import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { planInstantlyCopy, stepsOf, summarise } from "./copy-sequence-instantly.ts";

/*
 * The sequence shape here is the real one, read back from Instantly after
 * writing to a throwaway campaign: sequences[0].steps[], each step carrying
 * `delay`, `delay_unit` and a `variants` array of {subject, body}.
 */
const step = (subject: string, delay: number, variants = 1) => ({
  type: "email",
  delay,
  delay_unit: "days",
  variants: Array.from({ length: variants }, (_, i) => ({
    subject: variants === 1 ? subject : `${subject} ${String.fromCharCode(65 + i)}`,
    body: `<p>Hi {{firstName}}, ${subject}.</p>`,
  })),
});

const SOURCE = [{ steps: [step("step one", 0), step("step two", 3, 2)] }];

const plan = (mode: "replace" | "append", targetSequences: unknown, extra = {}) =>
  planInstantlyCopy({
    sourceId: "aaaaaaaa-0000-4000-8000-000000000001",
    sourceName: "Source",
    sourceSequences: SOURCE,
    targetId: "bbbbbbbb-0000-4000-8000-000000000002",
    targetName: "Target",
    targetStatus: 0,
    targetSequences: targetSequences as never,
    mode,
    ...extra,
  });

describe("planInstantlyCopy", () => {
  test("replace puts the source's steps on the target", () => {
    const p = plan("replace", null);
    assert.equal(p.steps.length, 2);
    assert.deepEqual(p.steps.map((s) => s.subject), ["step one", "step two A"]);
    assert.equal(stepsOf(p.sequences).length, 2);
  });

  test("replace reports what it discards", () => {
    const p = plan("replace", [{ steps: [step("old", 1)] }]);
    assert.deepEqual(p.removing.map((s) => s.subject), ["old"]);
  });

  test("append keeps the target's steps and adds the source's after them", () => {
    const p = plan("append", [{ steps: [step("existing", 1)] }]);
    assert.deepEqual(p.steps.map((s) => s.subject), ["existing", "step one", "step two A"]);
    assert.equal(p.removing.length, 0, "append discards nothing");
  });

  test("append onto a campaign with no sequence yet still works", () => {
    const p = plan("append", null);
    assert.equal(p.steps.length, 2);
  });

  test("variants come across, and a step's variant count is reported", () => {
    const p = plan("replace", null);
    assert.deepEqual(p.steps.map((s) => s.variantCount), [1, 2]);
    const copied = stepsOf(p.sequences);
    assert.equal(copied[1].variants?.length, 2);
    assert.equal(copied[1].variants?.[1]?.subject, "step two B");
  });

  test("a step with no variants counts as one, not zero", () => {
    assert.deepEqual(summarise([{ type: "email", delay: 0 }]).map((s) => s.variantCount), [1]);
  });

  test("the wait between steps is carried, not reset", () => {
    const copied = stepsOf(plan("replace", null).sequences);
    assert.deepEqual(copied.map((s) => s.delay), [0, 3]);
    assert.deepEqual(copied.map((s) => s.delay_unit), ["days", "days"]);
  });

  /*
   * The plan must own its data. If it shared objects with the source campaign,
   * editing the plan would edit the campaign it was read from.
   */
  test("the plan is a deep copy — mutating it cannot reach the source", () => {
    const p = plan("replace", null);
    stepsOf(p.sequences)[0].variants![0].subject = "MUTATED";
    assert.equal(SOURCE[0].steps[0].variants[0].subject, "step one");
  });

  test("fields other than steps are preserved rather than dropped", () => {
    const withExtras = [{ steps: [step("s", 0)], some_future_field: 42 }];
    const p = planInstantlyCopy({
      sourceId: "a", sourceName: "S", sourceSequences: withExtras,
      targetId: "b", targetName: "T", targetStatus: 0, targetSequences: null, mode: "replace",
    });
    assert.equal((p.sequences[0] as Record<string, unknown>).some_future_field, 42);
  });

  test("an empty source is a warning, not a silent no-op", () => {
    const p = planInstantlyCopy({
      sourceId: "a", sourceName: "Empty", sourceSequences: null,
      targetId: "b", targetName: "T", targetStatus: 0, targetSequences: null, mode: "replace",
    });
    assert.match(p.warnings.join(" "), /no sequence steps to copy/);
  });

  test("copying into itself is refused", () => {
    const p = planInstantlyCopy({
      sourceId: "same", sourceName: "X", sourceSequences: SOURCE,
      targetId: "same", targetName: "X", targetStatus: 0, targetSequences: null, mode: "replace",
    });
    assert.match(p.warnings.join(" "), /cannot copy its sequence into itself/);
  });

  test("an active target is called out — it is sending", () => {
    const p = plan("replace", null, { targetStatus: 1 });
    assert.equal(p.targetStatus, "active");
    assert.match(p.warnings.join(" "), /is sending/);
  });

  test("a draft target raises no alarm", () => {
    assert.deepEqual(plan("replace", null, { targetStatus: 0 }).warnings, []);
  });
});
