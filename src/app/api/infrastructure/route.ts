import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase/server";

/*
 * The sending estate (spec §8).
 *
 * Every number comes from an RPC, none from a `.select()` that the route then
 * groups. There are 1,470 inboxes and PostgREST caps a select at 1000 rows and
 * truncates silently — a by-domain rollup computed here would describe two
 * thirds of the estate while looking entirely plausible. That is rule 7 in
 * CLAUDE.md, and this is the table where it finally bites.
 */

export const dynamic = "force-dynamic";

const TEAM_ID = () => Number(process.env.EMAILBISON_TEAM_ID || 2);

/**
 * Default floor for the problem-account view.
 *
 * A bounce rate over three sends is noise: one bounce is 33% and means nothing.
 * 50 is low enough to catch a newly-warming inbox going bad and high enough
 * that the list is worth reading.
 */
const DEFAULT_MIN_SENT = 50;

export async function GET(request: NextRequest) {
  const sb = getSupabase();
  const teamId = TEAM_ID();
  const params = request.nextUrl.searchParams;

  const view = params.get("view") ?? "inbox"; // inbox | domain | provider | vendor
  const search = params.get("q")?.trim() || null;
  /*
   * NULL means "no sort" — the third click on a header — and each RPC falls
   * back to its own default order rather than an arbitrary one.
   */
  const sort = params.get("sort");
  const dir = params.get("dir") === "asc" ? "asc" : "desc";

  /*
   * Repeated params, so a value containing a comma survives — "Not connected"
   * is a real status. Empty means no filter, which is not the same as an empty
   * array (that would match nothing).
   */
  const list = (key: string) => {
    const values = params.getAll(key).filter(Boolean);
    return values.length ? values : null;
  };
  const bandFilter = list("band");
  const providerFilter = list("provider");
  const statusFilter = list("status");
  const vendorFilter = list("vendor");
  /*
   * The volume floor. On the rollups it is the DOMAIN's total, not each
   * mailbox's — a domain sending 5,000 across three inboxes is a 5,000-send
   * domain. That is why the two views get different parameters.
   */
  const minTotal = Math.max(Number(params.get("min_total") ?? 0) || 0, 0);
  /*
   * The recipient-side bounce card groups by provider or by domain, and has its
   * own volume floor for the same reason the sending side does: a provider with
   * four contacted leads and one bounce is 25% and means nothing.
   */
  const rcptGroup = params.get("rcpt") === "domain" ? "domain" : "esp";
  const rcptMinLeads = Math.max(Number(params.get("rcpt_min") ?? 50) || 0, 0);
  const minSent = Number(params.get("min_sent") ?? DEFAULT_MIN_SENT);
  const limit = Math.min(Number(params.get("limit") ?? 100), 500);
  const offset = Math.max(Number(params.get("offset") ?? 0), 0);

  const [totals, rows, problems, bands, providers, disconnected, vendors, recipients] =
    await Promise.all([
    sb.rpc("analytics_sender_totals", { p_team_id: teamId }),

    view === "inbox"
      ? sb.rpc("analytics_sender_rows", {
          p_team_id: teamId,
          // Still 0 by default — you should be able to find an inbox that has
          // never sent, which is itself a finding. The floor is opt-in.
          p_min_sent: minTotal,
          p_search: search,
          p_sort: sort,
          p_dir: dir,
          p_limit: limit,
          p_offset: offset,
          p_bands: bandFilter,
          p_providers: providerFilter,
          p_statuses: statusFilter,
          p_vendors: vendorFilter,
        })
      : sb.rpc("analytics_sender_groups", {
          p_team_id: teamId,
          p_group: view,
          p_min_sent: 0,
          // The domain and provider rollups had neither sort nor search until
          // now — the search box was rendered for the inbox view only, and this
          // function had no parameter to take one.
          p_sort: sort,
          p_dir: dir,
          p_search: search,
          p_bands: bandFilter,
          p_providers: providerFilter,
          p_statuses: statusFilter,
          p_min_total: minTotal,
          p_vendors: vendorFilter,
        }),

    // "Problem accounts surfaced by bounce rate, so a single bad inbox can be
    // spotted before it drags a campaign down." Always computed, whatever the
    // current view — it is the reason this page exists.
    sb.rpc("analytics_sender_rows", {
      p_team_id: teamId,
      p_min_sent: minSent,
      p_search: null,
      // Fixed, whatever the table is sorted by: this list exists to surface the
      // worst bounce rate, and following the table's sort would defeat it.
      p_sort: "bounce_rate",
      p_dir: "desc",
      p_limit: 12,
      p_offset: 0,
    }),

    /*
     * The distribution. "Bounce rate 1.80%" is an average over hundreds of
     * domains, and an average cannot distinguish a broad problem from a short
     * tail — 480 domains at 1.2% with 13 on fire averages the same as every
     * domain sitting at 1.8%. Those need opposite responses.
     */
    sb.rpc("analytics_sender_bands", { p_team_id: teamId, p_min_sent: 1 }),

    /*
     * The provider split, always — it is two rows and it belongs in the summary
     * whatever the table below is showing. §8 asks for a provider breakdown,
     * and "is one provider bouncing harder than the other" is a question you
     * answer at a glance or not at all.
     */
    sb.rpc("analytics_sender_groups", { p_team_id: teamId, p_group: "provider", p_min_sent: 1 }),

    /*
     * Every inbox that is not Connected, worst-first by the volume it was
     * carrying. Always computed, whatever the current view -- a dead inbox is
     * not a property of the table you happen to be looking at, and it is the
     * one thing on this page that is actionable today.
     */
    sb.rpc("analytics_disconnected_inboxes", { p_team_id: teamId, p_limit: 200 }),

    // The vendor facet for the filter control, read from the data so a vendor
    // added upstream needs no deploy.
    sb.rpc("analytics_sender_vendors", { p_team_id: teamId }),

    /*
     * WHERE the bounces land. The rest of this page is the sending side; this is
     * the only thing on it that describes the recipient, and the two need
     * opposite responses -- a bad sending domain is an inbox to pause, a bad
     * recipient provider is list data to drop.
     */
    sb.rpc("analytics_bounce_recipients", {
      p_team_id: teamId,
      p_group: rcptGroup,
      p_min_leads: rcptMinLeads,
      p_limit: 15,
    }),
  ]);

  const failed =
    totals.error ?? rows.error ?? problems.error ?? bands.error ?? providers.error ??
    disconnected.error ?? vendors.error ?? recipients.error;
  if (failed) {
    return NextResponse.json({ error: failed.message }, { status: 500 });
  }

  return NextResponse.json({
    view,
    totals: totals.data?.[0] ?? null,
    rows: rows.data ?? [],
    // `total_count` rides along on every row from the window function, so
    // paging doesn't need a second count query.
    total: view === "inbox" ? (rows.data?.[0]?.total_count ?? 0) : (rows.data?.length ?? 0),
    problems: problems.data ?? [],
    bands: bands.data ?? [],
    providers: providers.data ?? [],
    disconnected: disconnected.data ?? [],
    vendors: vendors.data ?? [],
    recipients: recipients.data ?? [],
    rcptGroup,
    rcptMinLeads,
    minSent,
  });
}
