import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase/server";
import { resolveFilters, toISODate } from "@/lib/analytics/query-params.ts";
import { resolvePlatformScope } from "@/lib/analytics/platform-scope.ts";
import { fetchFollowUpByCampaign } from "@/lib/analytics/follow-up.ts";

export const dynamic = "force-dynamic";

/**
 * Instantly's numeric campaign status, in the words the table already uses.
 *
 * 0 draft · 1 active · 2 paused · 3 completed · negative values are error
 * states. Anything unrecognised keeps its number rather than being forced into
 * a familiar-looking word — a status invented at render time is worse than one
 * that visibly needs looking up.
 */
function instantlyStatus(code: number): string {
  return (
    { 0: "draft", 1: "active", 2: "paused", 3: "completed" }[code] ??
    `status ${code}`
  );
}

export async function GET(request: NextRequest) {
  const teamId = Number(process.env.EMAILBISON_TEAM_ID || 2);
  let filters;
  try {
    filters = resolveFilters(request.nextUrl.searchParams, toISODate(new Date()));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid filters" },
      { status: 400 },
    );
  }

  try {
    /*
     * The follow-up medians come from the PORTAL, not from our database, so
     * they are fetched alongside rather than joined. Parallel because they are
     * independent, and the portal call is cached for 5 minutes upstream — so
     * this adds nothing to a repeat load.
     */
    const [{ data, error }, followUp] = await Promise.all([
      getSupabase().rpc("analytics_campaign_rows", {
      p_team_id: teamId,
      p_from: filters.from,
      p_to: filters.to,
      p_campaign_ids: filters.campaignIds.length ? filters.campaignIds : null,
      p_client_ids: filters.clientIds.length ? filters.clientIds : null,
    }),
      fetchFollowUpByCampaign(filters.from, filters.to),
    ]);
    if (error) throw new Error(error.message);

    const rows = (data ?? []).map((r: Record<string, unknown>) => ({
      campaignId: Number(r.campaign_id),
      campaignName: String(r.campaign_name),
      clientName: r.client_name as string | null,
      status: r.status as string | null,
      stepCount: Number(r.step_count),
      variantCount: Number(r.variant_count ?? 0),
      sent: Number(r.sent),
      prospects: Number(r.prospects),
      replies: Number(r.replies),
      humanReplies: Number(r.human_replies),
      positive: Number(r.positive),
      // The RPC has always returned these; the route dropped them, so the
      // Sentiment group could only ever draw "+". Both are real now that the
      // MasterInbox labels populate sentiment (046/048).
      negative: Number(r.negative),
      neutral: Number(r.neutral),
      botReplies: Number(r.bot_replies),
      bounces: Number(r.bounces),
      medianReplySeconds:
        r.median_reply_seconds === null ? null : Number(r.median_reply_seconds),
      avgReplySeconds:
        r.avg_reply_seconds === null || r.avg_reply_seconds === undefined
          ? null
          : Number(r.avg_reply_seconds),
      /*
       * Only present for campaigns with enough replies to have a median at all;
       * fetchFollowUpByCampaign drops the rest, so this is null -> DASH rather
       * than one person's reply time dressed up as a campaign average.
       */
      medianFollowUpSeconds: followUp.get(Number(r.campaign_id))?.seconds ?? null,
      followUpSampleSize: followUp.get(Number(r.campaign_id))?.sampleSize ?? null,
      bouncesHard: Number(r.bounces_hard ?? 0),
      bouncesSoft: Number(r.bounces_soft ?? 0),
      introductions: Number(r.introductions ?? 0),
      phoneScreens: Number(r.phone_screens ?? 0),
      interviews: Number(r.interviews ?? 0),
      hires: Number(r.hires ?? 0),
      outcomesTotal: Number(r.outcomes_total ?? 0),
      // Every row above comes from EmailBison. Named so the table can say so
      // once Instantly rows sit beside them.
      platform: "emailbison" as const,
    }));

    /*
     * INSTANTLY, when the platform filter asks for it.
     *
     * Appended rather than merged: an Instantly campaign is a different
     * campaign, not another view of an EmailBison one, and joining them by name
     * would silently fuse "Howe Realty Group - Maricopa" on one platform with
     * its namesake on the other — two real campaigns, two audiences, one row.
     *
     * The columns Instantly cannot fill are left ABSENT rather than zeroed:
     * positive (MasterInbox owns it), the sentiment split, reply timing and
     * outcomes. The formatters render a missing value as a dash, which is the
     * truth; a 0 would read as "none of these replies were positive".
     */
    /*
     * A campaign filter takes Instantly out of scope entirely — see
     * platform-scope.ts. Selecting campaign 55 and ticking Instantly used to
     * return all 315 Instantly campaigns beside it.
     */
    const scope = resolvePlatformScope({
      platforms: filters.platforms,
      campaignIds: filters.campaignIds,
    });
    const wantsInstantly = scope.instantly;
    const wantsEmailBison = scope.emailbison;

    let all = wantsEmailBison ? rows : [];

    if (wantsInstantly) {
      const { data: inst, error: instError } = await getSupabase().rpc(
        "analytics_instantly_campaign_rows",
        {
          p_team_id: teamId,
          p_from: filters.from,
          p_to: filters.to,
          p_client_ids: filters.clientIds.length ? filters.clientIds : null,
          /*
           * Safe as null ONLY because this branch is unreachable when a campaign
           * filter is set — resolvePlatformScope has already taken Instantly out
           * of scope. Null here means "no restriction", and reaching it with a
           * live campaign selection is what returned the whole workspace.
           */
          p_campaign_ids: null,
        },
      );
      if (instError) throw new Error(instError.message);

      const instRows = ((inst ?? []) as Record<string, unknown>[]).map((r) => ({
        campaignId: String(r.campaign_id),
        campaignName: String(r.campaign_name),
        clientName: (r.client_name as string | null) ?? null,
        status: instantlyStatus(Number(r.status)),
        stepCount: 0,
        variantCount: 0,
        sent: Number(r.sent),
        prospects: Number(r.prospects),
        replies: Number(r.replies),
        humanReplies: Number(r.human_replies),
        positive: null,
        negative: null,
        neutral: null,
        botReplies: null,
        bounces: r.bounces === null ? null : Number(r.bounces),
        medianReplySeconds: null,
        avgReplySeconds: null,
        medianFollowUpSeconds: null,
        followUpSampleSize: null,
        bouncesHard: null,
        bouncesSoft: null,
        introductions: null,
        phoneScreens: null,
        interviews: null,
        hires: null,
        outcomesTotal: null,
        platform: "instantly" as const,
      }));

      // Sorted together by volume so the table reads as one estate rather than
      // one platform stacked on the other.
      all = [...all, ...instRows].sort((a, b) => Number(b.sent) - Number(a.sent));
    }

    return NextResponse.json({
      rows: all,
      count: all.length,
      instantlyExcludedBy: scope.instantlyExcludedBy ?? null,
    });
  } catch (error) {
    console.error("[api/analytics/campaigns]", error);
    return NextResponse.json({ error: "Failed to load campaigns" }, { status: 500 });
  }
}
