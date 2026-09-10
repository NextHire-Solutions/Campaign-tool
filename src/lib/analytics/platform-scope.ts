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
  /** The EmailBison half of the campaign filter. */
  emailbisonCampaignIds: readonly number[];
  /** The Instantly half. The picker offers both, so both can be selected. */
  instantlyCampaignIds: readonly string[];
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
  const { platforms, emailbisonCampaignIds, instantlyCampaignIds } = input;
  const anyCampaignFilter =
    emailbisonCampaignIds.length > 0 || instantlyCampaignIds.length > 0;

  let emailbison = platforms.length === 0 || platforms.includes("emailbison");
  /*
   * SELECTING AN INSTANTLY CAMPAIGN IS ASKING FOR INSTANTLY.
   *
   * An empty platform filter otherwise means EmailBison (see below), so picking
   * an Instantly campaign and nothing else produced a scope of NEITHER platform
   * — an empty band, from a filter the user had just set. Naming a campaign is
   * a more specific request than leaving the platform blank, so it wins.
   */
  let instantly =
    platforms.includes("instantly") ||
    (platforms.length === 0 && instantlyCampaignIds.length > 0);

  /*
   * A CAMPAIGN SELECTION NAMES SPECIFIC CAMPAIGNS, so a platform with none of
   * them in the selection contributes nothing.
   *
   * This used to exclude Instantly from ANY campaign filter, because the filter
   * could only hold EmailBison integers — true then, and wrong now that the
   * picker offers both. The rule it was standing in for is the real one: a
   * platform is in scope only if the selection contains at least one of its
   * campaigns. `p_campaign_ids: null` meaning "no restriction" is what made
   * getting this wrong so expensive — it returned an entire workspace.
   */
  let instantlyExcludedBy: PlatformScope["instantlyExcludedBy"];
  if (anyCampaignFilter) {
    if (instantly && instantlyCampaignIds.length === 0) {
      instantly = false;
      instantlyExcludedBy = "campaign-filter";
    }
    if (emailbison && emailbisonCampaignIds.length === 0) emailbison = false;
  }

  return { emailbison, instantly, ...(instantlyExcludedBy ? { instantlyExcludedBy } : {}) };
}

/** The platforms a response actually covers, for the `coverage` field. */
export function coveredPlatforms(scope: PlatformScope): string[] {
  const out: string[] = [];
  if (scope.emailbison) out.push("emailbison");
  if (scope.instantly) out.push("instantly");
  return out;
}
