import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  countSpintaxGroups,
  countVariations,
  htmlToPlainText,
  rollSpintax,
} from "./spintax.ts";

// Real shape, from a live campaign body.
const REAL =
  "{Quick question, | Just a quick question, | I have a quick question,} " +
  "{are you open to joining a sales team? | would you consider a move?}";

describe("rollSpintax", () => {
  test("resolves every group — no braces or pipes survive", () => {
    const out = rollSpintax(REAL, 42);
    assert.ok(!out.includes("{"), out);
    assert.ok(!out.includes("|"), out);
  });

  test("trims whitespace around the pipe", () => {
    // Options are written as `{a, | b,}` with spaces; a naive split leaks them.
    const out = rollSpintax("{Hello | Hi}, there", 1);
    assert.ok(out === "Hello, there" || out === "Hi, there", out);
  });

  test("is deterministic — Preview must not re-roll on every render", () => {
    assert.equal(rollSpintax(REAL, 7), rollSpintax(REAL, 7));
  });

  test("a different seed can pick differently — Shuffle does something", () => {
    const seen = new Set(
      Array.from({ length: 40 }, (_, i) => rollSpintax(REAL, i)),
    );
    assert.ok(seen.size > 1, "expected more than one variation across seeds");
  });

  test("handles nesting rather than leaking braces", () => {
    const out = rollSpintax("{a|{b|c}}", 3);
    assert.ok(["a", "b", "c"].includes(out), out);
  });

  test("leaves a body with no spintax untouched", () => {
    assert.equal(rollSpintax("Hi {FIRST_NAME}, hello", 1), "Hi {FIRST_NAME}, hello");
  });

  test("terminates on malformed input instead of hanging", () => {
    const out = rollSpintax("{unclosed | group", 1);
    assert.equal(typeof out, "string");
  });
});

describe("counts", () => {
  test("counts groups, ignoring merge tags", () => {
    assert.equal(countSpintaxGroups(REAL), 2);
    assert.equal(countSpintaxGroups("Hi {FIRST_NAME}"), 0);
  });

  test("variations is the product of the option counts", () => {
    assert.equal(countVariations(REAL), 6); // 3 x 2
    assert.equal(countVariations("no spintax"), 1);
  });
});

describe("htmlToPlainText", () => {
  test("turns breaks and paragraphs into newlines", () => {
    assert.equal(htmlToPlainText("<p>Hi</p><p>There</p>"), "Hi\n\nThere");
    assert.equal(htmlToPlainText("a<br>b"), "a\nb");
  });

  test("decodes the entities that actually appear in these bodies", () => {
    assert.equal(htmlToPlainText("Douglas&nbsp;Elliman&rsquo;s"), "Douglas Elliman's");
    assert.equal(htmlToPlainText("A&amp;B"), "A&B");
  });

  test("preserves merge tags — they render literally at send time", () => {
    assert.ok(htmlToPlainText("<p>Hi {FIRST_NAME},</p>").includes("{FIRST_NAME}"));
  });
});

/*
 * Instantly writes spintax with a different marker. These lock down that it is
 * normalised at the door, so every downstream reader keeps working on one
 * syntax rather than learning a second.
 */

test("Instantly's {{RANDOM |...}} is read as a spintax group", () => {
  assert.equal(countSpintaxGroups("{{RANDOM |Hi|Hello|Hey}} there"), 1);
});

test("THE KEYWORD IS NEVER A CHOICE", () => {
  // Unnormalised, the parser matches the inner braces and treats "RANDOM " as
  // the first option — so the word RANDOM renders into a real email.
  const rolled = rollSpintax("{{RANDOM |Hi|Hello|Hey}} there", 7);
  assert.ok(!/RANDOM/.test(rolled), rolled);
  assert.ok(/^(Hi|Hello|Hey) there$/.test(rolled), rolled);
});

test("spacing around the marker does not matter", () => {
  assert.equal(countSpintaxGroups("{{RANDOM|a|b}}"), 1);
  assert.equal(countSpintaxGroups("{{ RANDOM |a|b}}"), 1);
  assert.equal(countSpintaxGroups("{{random |a|b}}"), 1);
});

test("merge tags are not spintax", () => {
  // 1,361 of 1,367 Instantly steps carry merge tags and no variation at all —
  // counting {{firstName}} as a group would hide exactly that.
  assert.equal(countSpintaxGroups("Hi {{firstName}}, from {{companyName}}"), 0);
});

test("EmailBison bodies are unaffected", () => {
  assert.equal(countSpintaxGroups("{Quick question, |Just checking, }hello"), 1);
  const rolled = rollSpintax("{Hi|Hello} there", 3);
  assert.ok(/^(Hi|Hello) there$/.test(rolled), rolled);
});

test("an empty group leaves no stray braces", () => {
  assert.ok(!/[{}]/.test(rollSpintax("{{RANDOM |}}x", 1)));
});
