/*
 * Campaign name → client matcher.
 *
 * All clients share one EmailBison workspace and are identified by their name
 * appearing somewhere in the campaign name. The dominant pattern is
 * `<Client>[ N] + <Persona> + <Segment>`, but it is not reliable enough to
 * parse — hence matching rather than splitting.
 *
 * Hazards this is built against, all observed in the live workspace:
 *
 *   "Copy of LIV Indy Realty 4 + Nicole + MIBOR"
 *       the client name is NOT always a prefix.
 *   "Kelly + Co + Nicole + BRIGHT"
 *       a client name can contain the `+` separator, so splitting on `+` is wrong.
 *   "Rise Real Estate Antelope" vs "Rise Real Estate Tujunga"
 *       separate clients sharing a 3-token prefix.
 *   "SERHANT. PA" vs "SERHANT. PA 15M+"
 *       one client name is a strict prefix of another.
 *   "The RE Home Group of Douglas Realty" vs "Douglas Elliman LA"
 *       share the token "douglas" but are unrelated.
 *   "Jeff Cook Real Estate LPT Realty  2"
 *       double spaces.
 *   "SERHANT. PA", "Properties & Estates", "RE/MAX Pacific"
 *       punctuation that must normalise away.
 *
 * Two rules do the real work:
 *   1. Match whole TOKEN RUNS, never raw substrings. This is what keeps a client
 *      named "Rise" out of "Sunrise Realty" — without it the whole scheme
 *      silently mis-attributes.
 *   2. Longest match wins, measured in tokens. This is what resolves every
 *      nested-name case above. Equal-length ties are flagged ambiguous and left
 *      unassigned rather than guessed, because a silent mis-attribution is worse
 *      than a visible gap: nobody goes looking for it.
 */

export type MatchMode = "contains" | "prefix" | "exact";

export interface MatchableClient {
  id: string;
  name: string;
  aliases?: string[];
  matchMode?: MatchMode;
}

export interface MatchResult {
  clientId: string | null;
  /** The client name or alias that won, for auditability. */
  matchedOn: string | null;
  /** Matched tokens / campaign tokens. Rough, but useful for sorting review queues. */
  confidence: number | null;
  /** More than one client matched with equal token length. */
  ambiguous: boolean;
  /** Every client that matched, longest first. Populated for the review UI. */
  candidates: Array<{ clientId: string; matchedOn: string; length: number }>;
}

/**
 * Lowercase, drop parenthesised asides, turn punctuation into spaces, collapse
 * whitespace. `&` becomes a space rather than "and" — "Properties & Estates"
 * and "Properties and Estates" both reduce to comparable token runs only if
 * both sides get the same treatment, and dropping is simpler than expanding.
 */
export function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ") // "(9)", "(Personal)", "(2)"
    .replace(/[^a-z0-9]+/g, " ") // punctuation -> space; keeps digits ("15m", "2")
    .trim()
    .replace(/\s+/g, " ");
}

export function tokenize(value: string): string[] {
  const normalized = normalize(value);
  return normalized ? normalized.split(" ") : [];
}

/**
 * Index of the first position where `needle` appears as a contiguous run of
 * whole tokens in `haystack`, or -1.
 */
function tokenRunIndex(haystack: string[], needle: string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;

  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function matchesUnderMode(
  campaignTokens: string[],
  candidateTokens: string[],
  mode: MatchMode,
): boolean {
  if (candidateTokens.length === 0) return false;

  switch (mode) {
    case "exact":
      return (
        campaignTokens.length === candidateTokens.length &&
        tokenRunIndex(campaignTokens, candidateTokens) === 0
      );
    case "prefix":
      return tokenRunIndex(campaignTokens, candidateTokens) === 0;
    case "contains":
    default:
      return tokenRunIndex(campaignTokens, candidateTokens) !== -1;
  }
}

/**
 * Resolves one campaign name against the client list.
 *
 * Deterministic: the same inputs always give the same answer regardless of
 * client ordering, because ties are broken by flagging rather than by taking
 * whichever came first.
 */
export function matchCampaign(
  campaignName: string,
  clients: MatchableClient[],
): MatchResult {
  const campaignTokens = tokenize(campaignName);

  const candidates: MatchResult["candidates"] = [];

  for (const client of clients) {
    const mode = client.matchMode ?? "contains";
    // A client's aliases are alternative spellings of the SAME client, so the
    // best-scoring one represents it — not each as a separate candidate, which
    // would make a client with many aliases look ambiguous against itself.
    let best: { matchedOn: string; length: number } | null = null;

    for (const candidate of [client.name, ...(client.aliases ?? [])]) {
      const tokens = tokenize(candidate);
      if (!matchesUnderMode(campaignTokens, tokens, mode)) continue;
      if (!best || tokens.length > best.length) {
        best = { matchedOn: candidate, length: tokens.length };
      }
    }

    if (best) {
      candidates.push({ clientId: client.id, matchedOn: best.matchedOn, length: best.length });
    }
  }

  if (candidates.length === 0) {
    return {
      clientId: null,
      matchedOn: null,
      confidence: null,
      ambiguous: false,
      candidates: [],
    };
  }

  candidates.sort((a, b) => b.length - a.length || a.clientId.localeCompare(b.clientId));

  const winner = candidates[0];
  const tied = candidates.filter((c) => c.length === winner.length);

  // Two DIFFERENT clients matched equally well. Refuse to guess.
  if (tied.length > 1) {
    return {
      clientId: null,
      matchedOn: null,
      confidence: null,
      ambiguous: true,
      candidates,
    };
  }

  return {
    clientId: winner.clientId,
    matchedOn: winner.matchedOn,
    confidence: campaignTokens.length
      ? Math.min(1, winner.length / campaignTokens.length)
      : null,
    ambiguous: false,
    candidates,
  };
}

/*
 * Campaigns that are not a client's work: templates, internal routing lists and
 * tests. Excluded from analytics entirely (migration 008).
 *
 * Matched on the NORMALISED campaign name so punctuation and casing don't
 * matter. Kept as explicit patterns rather than a heuristic ("does it contain
 * 'test'?") because a real client could legitimately be named "Test Valley
 * Realty", and silently dropping a paying client's volume is a much worse
 * failure than leaving one template campaign in.
 */
const EXCLUDE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^template /, reason: "template" },
  { pattern: /^interested (zf|no zf)/, reason: "internal routing list" },
  { pattern: /^not interested/, reason: "internal routing list" },
  { pattern: /\bopslabs test\b/, reason: "internal test" },
  { pattern: /^test client/, reason: "test campaign" },
  { pattern: /^new test client/, reason: "test campaign" },
  { pattern: /^test onboarding /, reason: "test campaign" },
  { pattern: /\btempo$/, reason: "draft/scratch campaign" },
  /*
   * Deliverability tests: "INBOX PLACEMENT TEST - Real Copy", "Copy of INBOX
   * PLACEMENT Neutral Copy". They send to seed mailboxes to measure where mail
   * lands, so they belong to no client and were sitting in Unassigned where
   * they read as unattributed client work.
   *
   * Safe to match on the phrase, unlike a bare "test": no real brokerage is
   * called "… inbox placement …", whereas one could well be called "Test Valley
   * Realty" — which is why the list above stays narrow.
   */
  { pattern: /\binbox placement\b/, reason: "deliverability test" },
];

/** Returns an exclusion reason, or null if the campaign counts as client work. */
export function exclusionReason(campaignName: string): string | null {
  const normalized = normalize(campaignName);
  for (const { pattern, reason } of EXCLUDE_PATTERNS) {
    if (pattern.test(normalized)) return reason;
  }
  return null;
}
