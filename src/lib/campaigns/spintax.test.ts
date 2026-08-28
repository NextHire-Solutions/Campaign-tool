import { test } from "node:test";
import assert from "node:assert/strict";

/*
 * The spintax detector, pinned against the SAME cases migration 064's SQL was
 * checked with. Two answers to "is this campaign spintaxed" on one screen would
 * be worse than none, so if either side is edited this file should fail.
 *
 * The regex is duplicated here rather than imported: sequence-view.tsx is a
 * "use client" React module and pulls in JSX and `@/` aliases that
 * `node --test` cannot resolve. What is under test is the pattern itself.
 */
const SPINTAX = /\{\{(?:[^{}]|\{[^{}]*\})*\|(?:[^{}]|\{[^{}]*\})*\}\}/;
const hasSpintax = (t: string | null | undefined) => (t ? SPINTAX.test(t) : false);

test("real spintax is detected", () => {
  assert.equal(hasSpintax("{{Quick question, | Just a quick question,}}"), true);
  assert.equal(hasSpintax("{{a|b}}"), true);
  assert.equal(hasSpintax("{{one | two | three}}"), true);
});

test("options containing a merge variable still count", () => {
  // The case a naive /\{[^{}]*\|[^{}]*\}/ MISSES: it cannot cross the inner
  // braces, so the best-personalised copy would read as unspintaxed.
  assert.equal(hasSpintax("{{Hi {FIRST_NAME}, | Hello {FIRST_NAME}, | Hey {FIRST_NAME},}}"), true);
  assert.equal(
    hasSpintax("<div>{{We're {COMPANY} | We are {COMPANY}}}, a top team.</div>"),
    true,
  );
});

test("a double-braced VARIABLE is not spintax", () => {
  // `{{firstName}}` appears 6 times in live copy. No pipe, so not a choice.
  assert.equal(hasSpintax("Hello {{firstName}} there"), false);
  assert.equal(hasSpintax("{{lastName}}"), false);
});

test("single-braced merge variables are not spintax", () => {
  // 471 occurrences of {FIRST_NAME} live. These are the most common braces in
  // the corpus, and counting them would report every campaign as spintaxed.
  assert.equal(hasSpintax("Hi {FIRST_NAME}, welcome"), false);
  assert.equal(hasSpintax("{TOP PRODUCING CITY} and {PHONE NUMBER}"), false);
});

test("plain copy and empty input", () => {
  assert.equal(hasSpintax("Are you open to joining a sales team?"), false);
  assert.equal(hasSpintax(""), false);
  assert.equal(hasSpintax(null), false);
  assert.equal(hasSpintax(undefined), false);
});

test("a pipe outside braces is not spintax", () => {
  // Tables and signatures use pipes as separators all the time.
  assert.equal(hasSpintax("Call us | Email us | Visit us"), false);
  assert.equal(hasSpintax("{FIRST_NAME} | Realtor"), false);
});
