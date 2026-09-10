/*
 * Spintax rendering.
 *
 * Format verified against live campaign bodies:
 *   {Quick question, | Just a quick question, | I have a quick question,}
 * Braces, pipe-separated, spaces around the pipe are common and must be
 * trimmed. Nesting has not been observed but is handled anyway — it costs one
 * recursive call and the alternative is silently emitting literal braces.
 *
 * Rolling is SEEDED and deterministic, so Preview stays stable while a user
 * reads it and only changes when they press Shuffle. An unseeded Math.random()
 * would re-roll on every React render, which looks like a bug.
 */

const GROUP = /\{([^{}]*\|[^{}]*)\}/;

/*
 * Instantly writes the same idea with a different marker:
 *
 *     {{RANDOM |Hi |Hello |Hey}}      Instantly
 *     {Hi|Hello|Hey}                  EmailBison
 *
 * Left as-is, the existing parser matches the INNER braces and reads "RANDOM "
 * as the first option — so a preview would render the word RANDOM into the
 * email and the group counter would count a group whose first choice is a
 * keyword. Normalising at the door means every downstream reader — the
 * preview, the counter, the variation estimate, the un-spintaxed signal —
 * keeps working on one syntax rather than learning a second.
 */
const INSTANTLY_GROUP = /\{\{\s*RANDOM\s*\|([^{}]*)\}\}/gi;

/**
 * Rewrites Instantly's `{{RANDOM |a|b}}` into `{a|b}`.
 *
 * Safe on EmailBison bodies, which contain no such marker, so callers can apply
 * it unconditionally instead of deciding per platform.
 */
export function normaliseSpintax(body: string): string {
  return body.replace(INSTANTLY_GROUP, (_match, inner: string) => {
    const options = String(inner)
      .split("|")
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
    // A group with nothing to choose between is not a group. Emitting `{}` here
    // would leave a literal brace pair in the rendered email.
    return options.length ? `{${options.join("|")}}` : "";
  });
}

/** Small deterministic PRNG — mulberry32. Same seed, same output. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Resolves every spintax group, innermost first.
 *
 * Loop-bounded rather than recursive-until-clean: a malformed body could
 * otherwise spin forever, and a half-rendered email is a better failure than a
 * hung tab.
 */
export function rollSpintax(body: string, seed = 1): string {
  const next = rng(seed);
  let out = normaliseSpintax(body);

  for (let guard = 0; guard < 200; guard++) {
    const match = GROUP.exec(out);
    if (!match) break;
    const options = match[1].split("|").map((s) => s.trim());
    const choice = options[Math.floor(next() * options.length)] ?? options[0];
    out = out.slice(0, match.index) + choice + out.slice(match.index + match[0].length);
  }

  return out;
}

/** Number of spintax groups, for the "N variations" hint. */
export function countSpintaxGroups(body: string): number {
  return (normaliseSpintax(body).match(/\{[^{}]*\|[^{}]*\}/g) ?? []).length;
}

/**
 * How many distinct emails the spintax can produce — the product of each
 * group's option count. Useful context: 7 groups of 3 is 2,187 variants, which
 * is the point of spintax and worth surfacing.
 */
export function countVariations(body: string): number {
  const groups = normaliseSpintax(body).match(/\{[^{}]*\|[^{}]*\}/g) ?? [];
  return groups.reduce(
    (total, g) => total * g.slice(1, -1).split("|").length,
    1,
  );
}

/** Strips HTML to readable text, for the plain view. */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
