/*
 * Which platforms a set of filters actually describes.
 *
 * THE BUG THIS EXISTS TO PREVENT, stated plainly: filtering to one EmailBison
 * campaign and ticking Instantly reported 43,283 sent for a campaign that sent
 * 2. The campaign filter holds EmailBison integer ids, which cannot name an
 * Instantly campaign, so every Instantly query dropped the filter and returned
 * the ENTIRE workspace — then added it to the one campaign the user asked
 * about. The KPI band, the chart, the Campaigns table and the Clients table all
 * did it, each having made the same reasonable-looking local decision.
 *
 * `p_campaign_ids: null` was the wrong translation of "this filter cannot apply
 * here". Null means "no restriction" — everything. The right answer when a
 * selection cannot include any Instantly campaign is NOTHING, not everything.
 * The two are as far apart as an answer can be, and the wrong one fails upward:
 * it inflates volume, so nobody questions it.
 *
 * Kept free of `@/` imports on purpose — Node's native TS stripping cannot
 * resolve path aliases, and this needs to be directly testable.
 */

export interface PlatformScopeInput {
  /** Empty means "not narrowed", which is not the same as "both". */
  platforms: readonly string[];
  /** EmailBison campaign ids. Instantly campaigns are UUID-keyed. */
  campaignIds: readonly number[];
}

export interface PlatformScope {
  emailbison: boolean;
  instantly: boolean;
  /**
   * Set when Instantly was asked for but cannot be answered, so the caller can
   * say why rather than render an unexplained zero.
   */
  instantlyExcludedBy?: "campaign-filter";
}

/**
 * Resolves the platforms in scope, honouring the campaign filter.
 *
 * An empty `platforms` means EmailBison only, NOT both, and that asymmetry is
 * deliberate rather than an oversight — Positive is decided by MasterInbox
 * labels keyed to EmailBison reply ids, so defaulting the headline band to both
 * would dash Positive, Positive Rate and Lead to Email for everyone who never
 * touches the filter. Volume, which has no Positive, defaults to both instead
 * and says so on screen.
 */
export function resolvePlatformScope(input: PlatformScopeInput): PlatformScope {
  const { platforms, campaignIds } = input;

  const emailbison = platforms.length === 0 || platforms.includes("emailbison");
  const askedForInstantly = platforms.includes("instantly");

  /*
   * A campaign selection is a list of specific campaigns. Since every id in it
   * is an EmailBison integer, no Instantly campaign is in the selection, so
   * Instantly's correct contribution is zero rows — the same answer you would
   * get from a filter that could express it.
   */
  if (askedForInstantly && campaignIds.length > 0) {
    return { emailbison, instantly: false, instantlyExcludedBy: "campaign-filter" };
  }

  return { emailbison, instantly: askedForInstantly };
}

/** The platforms a response actually covers, for the `coverage` field. */
export function coveredPlatforms(scope: PlatformScope): string[] {
  const out: string[] = [];
  if (scope.emailbison) out.push("emailbison");
  if (scope.instantly) out.push("instantly");
  return out;
}
