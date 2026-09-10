import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase/server";
import { resolveFilters, toISODate } from "@/lib/analytics/query-params.ts";
import { resolvePlatformScope } from "@/lib/analytics/platform-scope.ts";

export const dynamic = "force-dynamic";

/*
 * The individual replies under the breakdown cards (spec §5.5).
 *
 * `dimension` + `value` are the drill-down: clicking a bar shows exactly the
 * replies that bar counted. Both the chart and this list resolve a reply's
 * bucket through the same `reply_dimension_value` SQL function, so the count on
 * the bar and the number of rows here cannot drift apart.
 *
 * Paged in SQL — PostgREST truncates a .select() at 1000 rows without saying so.
 */

const PAGE_SIZE = 50;

interface Row {
  id: number;
  date_received: string;
  from_name: string | null;
  from_email: string | null;
  subject: string | null;
  preview: string | null;
  interested: boolean;
  automated: boolean;
  campaign_id: number | null;
  campaign_name: string | null;
  client_name: string | null;
  lead_id: number | null;
  company: string | null;
  office_city: string | null;
  sales_volume: string | null;
  logged: string[] | null;
  total_count: number;
}

export async function GET(request: NextRequest) {
  const teamId = Number(process.env.EMAILBISON_TEAM_ID || 2);
  const params = request.nextUrl.searchParams;

  let filters;
  try {
    filters = resolveFilters(params, toISODate(new Date()));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid filters" },
      { status: 400 },
    );
  }

  const page = Math.max(1, Number(params.get("page")) || 1);

  /*
   * THE PLATFORM FILTER WAS IGNORED HERE. Every request returned EmailBison's
   * replies, so selecting Instantly showed 5,761 EmailBison replies under an
   * Instantly label — identical totals under every platform, which was the
   * tell. Same failure as the campaign-filter leak, and it fails upward
   * because the numbers look perfectly plausible.
   */
  const scope = resolvePlatformScope({
    platforms: filters.platforms,
    emailbisonCampaignIds: filters.emailbisonCampaignIds,
    instantlyCampaignIds: filters.instantlyCampaignIds,
  });

  if (scope.instantly && !scope.emailbison) {
    const { data, error } = await getSupabase().rpc("analytics_instantly_reply_rows", {
      p_team_id: teamId,
      p_from: filters.from,
      p_to: filters.to,
      p_client_ids: filters.clientIds.length ? filters.clientIds : null,
      p_search: params.get("q")?.trim() || null,
      p_dimension: params.get("dimension") || null,
      p_value: params.get("value") || null,
      p_limit: PAGE_SIZE,
      p_offset: (page - 1) * PAGE_SIZE,
    });
    if (error) {
      console.error("[api/analytics/replies/rows:instantly]", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    type InstRow = {
      reply_id: string; received_date: string; from_email: string | null;
      lead_name: string | null; company: string | null; campaign_name: string | null;
      client_name: string | null; subject: string | null; preview: string | null;
      esp: string | null; mailbox_kind: string | null; total_count: number;
    };
    const list = (data ?? []) as InstRow[];
    return NextResponse.json({
      platform: "instantly",
      page,
      pageSize: PAGE_SIZE,
      total: Number(list[0]?.total_count ?? 0),
      rows: list.map((r) => ({
        replyId: r.reply_id,
        receivedDate: r.received_date,
        fromEmail: r.from_email,
        leadName: r.lead_name,
        company: r.company,
        campaignName: r.campaign_name,
        clientName: r.client_name,
        subject: r.subject,
        preview: r.preview,
        esp: r.esp,
        mailboxKind: r.mailbox_kind,
        /*
         * Absent, not false. "Positive" is a MasterInbox label keyed to
         * EmailBison reply ids; no Instantly reply has one, so a `false` here
         * would assert that a reply was judged and found negative.
         */
        sentiment: null,
        positive: null,
      })),
    });
  }

  /*
   * BOTH platforms selected is refused rather than silently served as one.
   * The two reply sets answer different questions — EmailBison's carry
   * sentiment and enriched lead attributes, Instantly's do not — and merging
   * them would produce a list whose columns are populated for some rows and
   * empty for others with no way to tell which is which.
   */
  if (scope.instantly && scope.emailbison) {
    return NextResponse.json({
      platform: "mixed",
      page,
      pageSize: PAGE_SIZE,
      total: 0,
      rows: [],
      unavailable:
        "Reply detail covers one platform at a time. EmailBison replies carry sentiment and lead attributes that Instantly does not report, so the two lists cannot be merged without inventing the missing half. Pick a single platform.",
    });
  }

  try {
    const { data, error } = await getSupabase().rpc("analytics_reply_rows", {
      p_team_id: teamId,
      p_from: filters.from,
      p_to: filters.to,
      p_client_ids: filters.clientIds.length ? filters.clientIds : null,
      p_campaign_ids: filters.emailbisonCampaignIds.length ? filters.emailbisonCampaignIds : null,
      p_positive_only: params.get("positive") === "1",
      p_dimension: params.get("dimension") || null,
      p_value: params.get("value") || null,
      p_search: params.get("q")?.trim() || null,
      p_limit: PAGE_SIZE,
      p_offset: (page - 1) * PAGE_SIZE,
      p_company: filters.replyFacets.company?.length ? filters.replyFacets.company : null,
      p_location: filters.replyFacets.location?.length ? filters.replyFacets.location : null,
      p_sales_volume: filters.replyFacets.sales_volume?.length
        ? filters.replyFacets.sales_volume
        : null,
    });
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as Row[];

    return NextResponse.json({
      page,
      pageSize: PAGE_SIZE,
      total: rows.length ? Number(rows[0].total_count) : 0,
      rows: rows.map((r) => ({
        id: r.id,
        receivedAt: r.date_received,
        fromName: r.from_name,
        fromEmail: r.from_email,
        subject: r.subject,
        preview: r.preview,
        interested: r.interested,
        automated: r.automated,
        campaignId: r.campaign_id,
        campaign: r.campaign_name,
        client: r.client_name,
        leadId: r.lead_id,
        company: r.company,
        officeCity: r.office_city,
        salesVolume: r.sales_volume,
        logged: r.logged ?? [],
      })),
    });
  } catch (error) {
    console.error("[api/analytics/replies/rows]", error);
    return NextResponse.json({ error: "Failed to load replies" }, { status: 500 });
  }
}
