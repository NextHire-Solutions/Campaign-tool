import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase/server";
import { resolveFilters, toISODate } from "@/lib/analytics/query-params.ts";

/*
 * Sending capacity, and where the volume actually went.
 *
 * Capacity is deliberately NOT date-filtered: "how much can we send a day" is a
 * property of the estate right now, not of the window being looked at. The
 * split is, because "where did the volume go" is only meaningful over a period.
 * Putting both on one screen means saying which is which, which the component
 * does in the tile's own subtitle.
 */

export const dynamic = "force-dynamic";

const TEAM_ID = () => Number(process.env.EMAILBISON_TEAM_ID || 2);

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

  const group = request.nextUrl.searchParams.get("group") === "campaign"
    ? "campaign"
    : "client";

  const sb = getSupabase();
  const [capacity, split] = await Promise.all([
    sb.rpc("analytics_sending_capacity", { p_team_id: TEAM_ID() }),
    sb.rpc("analytics_volume_split", {
      p_team_id: TEAM_ID(),
      p_from: filters.from,
      p_to: filters.to,
      p_group: group,
      p_client_ids: filters.clientIds.length ? filters.clientIds : null,
      // 25 bars is already more than anyone reads down; the grand total on
      // every row means the share stays correct despite the truncation.
      p_limit: 25,
    }),
  ]);

  const failed = capacity.error ?? split.error;
  if (failed) {
    console.error("[api/analytics/volume]", failed);
    return NextResponse.json({ error: failed.message }, { status: 500 });
  }

  const rows = (split.data ?? []) as Array<{
    label: string;
    platform: string;
    sent: number;
    grand_total: number;
  }>;

  /*
   * Days in the window, so the tile can compare a period total against a DAILY
   * capacity. Comparing 269,556 sent against 35,720 a day would read as 750%
   * utilisation; the ratio only means anything per day.
   */
  const days =
    Math.round(
      (Date.parse(filters.to) - Date.parse(filters.from)) / 86_400_000,
    ) + 1;

  return NextResponse.json({
    capacity: capacity.data ?? [],
    rows,
    total: Number(rows[0]?.grand_total ?? 0),
    days,
    group,
    range: { from: filters.from, to: filters.to },
  });
}
