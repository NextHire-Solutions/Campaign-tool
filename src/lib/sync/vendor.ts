import type { EBTag } from "../emailbison/types.ts";

/**
 * Who sold us this inbox, from its EmailBison tags.
 *
 * THE `p.` PREFIX IS THE RULE, DELIBERATELY — not a list of vendor names. The
 * estate carries three kinds of tag: system ones EmailBison sets (`Google`,
 * `Custom Mail Server`, all `default: true`), pool tags naming who runs the
 * inbox (`Nicole Pool`, `BrokerStaffer`), and a `p.` namespace naming the
 * vendor. Matching on the namespace means a sixth vendor appears on its own;
 * matching on a hard-coded list would drop it silently into "Untagged" while
 * every total still added up, which is the kind of wrong nobody catches.
 *
 * The trailing connection word is stripped: `p.LeadGenJay Google` and
 * `p.Mission Inbox Custom` name vendors, not connection types — `provider`
 * already records that, and keeping it here would split one vendor in two.
 * Verified across all 1,496 inboxes: no inbox carries two vendor tags, so
 * vendor is single-valued and vendor totals sum to the estate.
 *
 * Returns null rather than a guess. "Untagged" is a finding.
 *
 * Lives in its own module rather than in jobs.ts so it can be tested: jobs.ts
 * pulls in the Supabase client through a `@/` alias, which `node --test`
 * cannot resolve.
 */
export function vendorFromTags(tags: EBTag[] | undefined): string | null {
  const tag = (tags ?? []).find((t) => !t.default && /^p\./i.test(t.name ?? ""));
  if (!tag) return null;
  const name = tag.name.replace(/^p\./i, "").trim();
  // Only strip the suffix when something is left: a vendor literally called
  // "Google" must survive as "Google" rather than becoming an empty label.
  const stripped = name.replace(/\s+(Google|Custom)$/i, "").trim();
  return stripped || name || null;
}
