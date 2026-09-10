import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase/server";
import { platformOfId } from "@/lib/campaigns/campaign-id.ts";

/*
 * One page of a campaign's leads (the Leads tab on the campaign page).
 *
 * NO DATE RANGE, and that is deliberate. The campaign page has no filter bar,
 * `resolveFilters` does not apply here, and "who has this campaign contacted" is
 * a lifetime question — a range would answer a different one and invite the
 * reading that a lead outside it was never contacted.
 *
 * Search, status filter, sort and paging all happen in SQL. A campaign has up to
 * ~5,000 leads and PostgREST truncates a `.select()` at 1,000 rows without
 * saying so (CLAUDE.md rule 7), so none of this can be done in JS over a select.
 */

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

/** Keeps null as null; only real values become numbers. */
const nullableNumber = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);
const TEAM_ID = () => Number(process.env.EMAILBISON_TEAM_ID || 2);

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  /*
   * The platform is read off the id's SHAPE. That is sound here and only here:
   * the path IS the id, so there is no pair to carry a platform in, and the two
   * key spaces cannot collide — a uuid is never a valid EmailBison id and an
   * integer is never a valid Instantly one. A malformed id gets a 400 rather
   * than being routed at one platform and reported as missing there.
   */
  const platform = platformOfId(id);
  if (!platform) {
    return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 });
  }
  const campaignId = platform === "emailbison" ? Number(id) : id;

  const q = request.nextUrl.searchParams;
  const page = Math.max(1, Number(q.get("page") ?? 1));
  const search = q.get("q")?.trim() || null;
  const status = q.getAll("status").filter(Boolean);
  // NULL sort means "no sort" — the third click — and the RPC falls back to its
  // own default rather than an arbitrary one.
  const sort = q.get("sort");
  const dir = q.get("dir") === "asc" ? "asc" : "desc";

  const sb = getSupabase();
  const teamId = TEAM_ID();

  /*
   * The status counts do not depend on the page, the sort or the search — they
   * describe the whole campaign. Recomputing them on every page turn doubled the
   * cost of paging for nothing (measured: 333ms of rows + 319ms of facets on a
   * 6,288-lead campaign). The client asks for them once and caches them against
   * the campaign id alone.
   */
  const wantFacets = q.get("facets") === "1";

  /*
   * "Select every lead matching this filter", for the removal flow. Returns ids
   * only, from a function that shares this one's filter logic verbatim (067) —
   * if the two ever disagreed, the dialog would state a count that was true of
   * neither the screen nor the removal.
   *
   * Answered here and returned early: it needs neither the page nor the facets,
   * and running the decorated row query for a list of integers is exactly what
   * 067 exists to avoid.
   */
  if (q.get("ids") === "1") {
    const { data, error } = await sb.rpc(
      platform === "instantly" ? "analytics_instantly_lead_ids" : "analytics_campaign_lead_ids",
      platform === "instantly"
        ? {
            p_team_id: teamId,
            p_campaign_id: campaignId,
            p_search: search,
            p_status: status.length ? status : null,
          }
        : {
      p_team_id: teamId,
      p_campaign_id: campaignId,
      p_search: search,
      p_status: status.length ? status : null,
    },
    );
    if (error) {
      console.error("[api/campaigns/leads:ids]", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    /*
     * One row holding an array, deliberately — see 067. A row per id would be
     * truncated at 1,000 by PostgREST without a word, and "select all 6,288"
     * would quietly select 1,000.
     */
    // Instantly lead ids are uuids; EmailBison's are integers. Both travel as
    // themselves — coercing either would break the removal call.
    const ids = (data ?? []) as Array<number | string>;
    return NextResponse.json({ leadIds: ids, total: ids.length });
  }

  /*
   * INSTANTLY'S ROWS ARE A DIFFERENT SHAPE, not a subset. It has no step
   * counter, no per-lead sender, no per-lead bounce signal and no lead
   * attributes — so those come back absent rather than zeroed, and the
   * formatters render a dash. A 0 would read as "this lead was never opened"
   * when the truth is "Instantly does not report it".
   */
  if (platform === "instantly") {
    const { data, error } = await sb.rpc("analytics_instantly_lead_rows", {
      p_team_id: teamId,
      p_campaign_id: campaignId,
      p_search: search,
      p_status: status.length ? status : null,
      p_limit: PAGE_SIZE,
      p_offset: (page - 1) * PAGE_SIZE,
    });
    if (error) {
      console.error("[api/campaigns/leads:instantly]", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    type InstRow = {
      lead_id: string; email: string | null; first_name: string | null;
      last_name: string | null; company: string | null; status: string;
      raw_status: number | null; replies: number; opens: number;
      last_sent_at: string | null; total_count: number;
    };
    const list = (data ?? []) as InstRow[];
    const total = Number(list[0]?.total_count ?? 0);

    /*
     * Counted in SQL (086). This was a JS tally over the row RPC asking for
     * every row, which PostgREST silently truncated at 1,000 — so a campaign of
     * 12,080 leads showed facets summing to exactly 1,000. Rule 7, again.
     */
    let facetRows: Array<{ status: string; leads: number }> = [];
    if (wantFacets) {
      const { data: f } = await sb.rpc("analytics_instantly_lead_facets", {
        p_team_id: teamId,
        p_campaign_id: campaignId,
      });
      facetRows = (f ?? []) as Array<{ status: string; leads: number }>;
    }

    return NextResponse.json({
      platform,
      rows: list.map((r) => ({
        leadId: r.lead_id,
        email: r.email,
        firstName: r.first_name,
        lastName: r.last_name,
        company: r.company,
        title: null,
        leadStatus: null,
        status: r.status,
        stepReached: null,
        sends: null,
        firstSentAt: null,
        lastSentAt: r.last_sent_at,
        opens: r.opens,
        uniqueOpens: null,
        clicks: null,
        replies: r.replies,
        positive: null,
        bounces: null,
        senderEmail: null,
        attributes: {},
      })),
      page,
      pageSize: PAGE_SIZE,
      total,
      facets: facetRows,
    });
  }

  const [rows, facets] = await Promise.all([
    sb.rpc("analytics_campaign_lead_rows", {
      p_team_id: teamId,
      p_campaign_id: campaignId,
      p_search: search,
      p_status: status.length ? status : null,
      p_sort: sort,
      p_dir: dir,
      p_limit: PAGE_SIZE,
      p_offset: (page - 1) * PAGE_SIZE,
    }),
    wantFacets
      ? sb.rpc("analytics_campaign_lead_facets", {
          p_team_id: teamId,
          p_campaign_id: campaignId,
        })
      : Promise.resolve({ data: [], error: null }),
  ]);

  const failed = rows.error ?? facets.error;
  if (failed) {
    console.error("[api/campaigns/leads]", failed);
    return NextResponse.json({ error: failed.message }, { status: 500 });
  }

  type Row = {
    lead_id: number;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
    company: string | null;
    title: string | null;
    lead_status: string | null;
    status: string;
    step_reached: number | null;
    sends: number;
    first_sent_at: string | null;
    last_sent_at: string | null;
    opens: number;
    unique_opens: number;
    clicks: number;
    replies: number;
    positive: number;
    bounces: number;
    sender_email: string | null;
    attributes: Record<string, string>;
    total_count: number;
  };

  const data = (rows.data ?? []) as Row[];

  return NextResponse.json({
    rows: data.map((r) => ({
      leadId: r.lead_id,
      email: r.email,
      name: [r.first_name, r.last_name].filter(Boolean).join(" ") || null,
      company: r.company,
      title: r.title,
      leadStatus: r.lead_status,
      status: r.status,
      stepReached: r.step_reached,
      /*
       * NULL SURVIVES AS NULL. `Number(null)` is 0, and these columns are
       * deliberately null for a lead we know was contacted but hold no send row
       * for — someone who bounced, where EmailBison keeps no `sent` record
       * (072). Coercing that to 0 would put "never emailed" on screen next to a
       * bounce, which is the exact confusion rule 1 exists to prevent. The
       * formatters already render null as a dash.
       */
      sends: nullableNumber(r.sends),
      firstSentAt: r.first_sent_at,
      lastSentAt: r.last_sent_at,
      opens: nullableNumber(r.opens),
      uniqueOpens: nullableNumber(r.unique_opens),
      clicks: nullableNumber(r.clicks),
      replies: Number(r.replies),
      positive: Number(r.positive),
      bounces: Number(r.bounces),
      senderEmail: r.sender_email,
      attributes: r.attributes ?? {},
    })),
    // Rides along on every row from the window function, so paging needs no
    // second count query.
    total: Number(data[0]?.total_count ?? 0),
    page,
    pageSize: PAGE_SIZE,
    facets: (facets.data ?? []) as Array<{ status: string; leads: number }>,
  });
}
