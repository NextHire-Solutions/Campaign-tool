import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase/server";
import { resolveFilters, toISODate } from "@/lib/analytics/query-params.ts";

/*
 * Proposed offer groups, discovered rather than entered.
 *
 * Campaigns that open with the same email ARE the same offer. Over the live
 * workspace that is 36 campaigns on "Join a Zillow preferred brokerage?" and 24
 * on "Hiring Agents for Zillow Preferred leads" — groups nobody should have to
 * assemble by hand.
 *
 * Read-only. Creating an offer from a proposal is an explicit act, because
 * naming is the part a human is actually needed for.
 */

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  let filters;
  try {
    filters = resolveFilters(request.nextUrl.searchParams, toISODate(new Date()));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid filters" },
      { status: 400 },
    );
  }

  const { data, error } = await getSupabase().rpc("analytics_offer_suggestions", {
    p_team_id: Number(process.env.EMAILBISON_TEAM_ID || 2),
    p_from: filters.from,
    p_to: filters.to,
    p_campaign_ids: filters.emailbisonCampaignIds.length ? filters.emailbisonCampaignIds : null,
    p_client_ids: filters.clientIds.length ? filters.clientIds : null,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    from: filters.from,
    to: filters.to,
    // A proposal whose campaigns are all already attached to an offer is done,
    // not a suggestion.
    suggestions: (data ?? []).filter(
      (s: { campaigns: number; claimed: number }) => s.claimed < s.campaigns,
    ),
  });
}
