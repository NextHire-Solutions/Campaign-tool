import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase/server";
import { resolveFilters, toISODate } from "@/lib/analytics/query-params.ts";
import { resolvePlatformScope } from "@/lib/analytics/platform-scope.ts";
import {
  bounceRate,
  humanRate,
  leadToEmail,
  positiveRate,
  replyRate,
} from "@/lib/analytics/metrics.ts";

export const dynamic = "force-dynamic";

interface Row {
  client_id: string | null;
  client_name: string;
  campaign_count: number;
  ambiguous_count: number;
  sent: number;
  prospects: number;
  replies: number;
  human_replies: number;
  positive: number;
  bounces: number;
  median_reply_seconds: number | null;
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
    const { data, error } = await getSupabase().rpc("analytics_client_rows", {
      p_team_id: teamId,
      p_from: filters.from,
      p_to: filters.to,
      p_campaign_ids: filters.campaignIds.length ? filters.campaignIds : null,
      p_client_ids: filters.clientIds.length ? filters.clientIds : null,
    });
    if (error) throw new Error(error.message);

    const rows = ((data ?? []) as Row[]).map((r) => {
      const sent = Number(r.sent);
      const replies = Number(r.replies);
      const positive = Number(r.positive);
      return {
        clientId: r.client_id,
        name: r.client_name,
        campaignCount: Number(r.campaign_count),
        ambiguousCount: Number(r.ambiguous_count),
        sent,
        prospects: Number(r.prospects),
        replies,
        humanReplies: Number(r.human_replies),
        positive,
        bounces: Number(r.bounces),
        // Derived here, from the SAME functions the KPI band uses, so a client
        // row and the tile above it can never disagree on a formula.
        replyRate: replyRate(replies, sent),
        humanRate: humanRate(Number(r.human_replies), sent),
        positiveRate: positiveRate(positive, replies),
        leadToEmail: leadToEmail(sent, positive),
        bounceRate: bounceRate(Number(r.bounces), sent),
        medianReplySeconds:
          r.median_reply_seconds === null ? null : Number(r.median_reply_seconds),
      };
    });

    /*
     * INSTANTLY, folded into the SAME client rows.
     *
     * Merged rather than appended, unlike the campaigns table: a client is one
     * client on both platforms, and giving "Douglas Elliman NYC" two rows would
     * make the table read as two clients and break the footer's reconciliation
     * with the KPI band.
     *
     * POSITIVE STAYS THE EMAILBISON FIGURE and is therefore NOT re-derived into
     * positiveRate once Instantly replies join the denominator — that would
     * halve every rate. The rate goes null instead, and the band above already
     * dashes Positive in this mode for the same reason.
     */
    /*
     * A campaign filter takes Instantly out of scope — see platform-scope.ts.
     * analytics_instantly_client_rows has no campaign parameter at all, so with
     * a campaign selected it returned every client on the platform.
     */
    const scope = resolvePlatformScope({
      platforms: filters.platforms,
      campaignIds: filters.campaignIds,
    });
    const wantsInstantly = scope.instantly;
    const wantsEmailBison = scope.emailbison;

    let merged = wantsEmailBison ? rows : [];

    if (wantsInstantly) {
      const { data: inst, error: instError } = await getSupabase().rpc(
        "analytics_instantly_client_rows",
        {
          p_team_id: teamId,
          p_from: filters.from,
          p_to: filters.to,
          p_client_ids: filters.clientIds.length ? filters.clientIds : null,
        },
      );
      if (instError) throw new Error(instError.message);

      const byId = new Map(merged.map((r) => [r.clientId ?? r.name, r]));

      for (const r of (inst ?? []) as Array<Record<string, unknown>>) {
        const key = (r.client_id as string | null) ?? String(r.client_name);
        const add = {
          sent: Number(r.sent ?? 0),
          prospects: Number(r.prospects ?? 0),
          replies: Number(r.replies ?? 0),
          humanReplies: Number(r.human_replies ?? 0),
          bounces: r.bounces === null ? 0 : Number(r.bounces),
          campaigns: Number(r.campaigns ?? 0),
        };
        const existing = byId.get(key);
        if (existing) {
          existing.sent += add.sent;
          existing.prospects += add.prospects;
          existing.replies += add.replies;
          existing.humanReplies += add.humanReplies;
          existing.bounces += add.bounces;
          existing.campaignCount += add.campaigns;
        } else {
          byId.set(key, {
            clientId: (r.client_id as string | null) ?? null,
            name: String(r.client_name),
            campaignCount: add.campaigns,
            ambiguousCount: 0,
            sent: add.sent,
            prospects: add.prospects,
            replies: add.replies,
            humanReplies: add.humanReplies,
            positive: 0,
            bounces: add.bounces,
            replyRate: null,
            humanRate: null,
            positiveRate: null,
            leadToEmail: null,
            bounceRate: null,
            medianReplySeconds: null,
          });
        }
      }

      /*
       * Recomputed on the merged totals, from the same formulas the KPI band
       * uses. positiveRate and leadToEmail are deliberately NOT recomputed:
       * their numerator covers only EmailBison while the denominator now covers
       * both, so any value would understate. Null renders as a dash.
       */
      merged = [...byId.values()]
        .map((r) => ({
          ...r,
          replyRate: replyRate(r.replies, r.sent),
          humanRate: humanRate(r.humanReplies, r.sent),
          positiveRate: null,
          leadToEmail: null,
          bounceRate: bounceRate(r.bounces, r.sent),
        }))
        .sort((a, b) => b.sent - a.sent);
    }

    // Totals are summed from the SAME rows the table renders, not queried
    // separately -- so the footer can never disagree with what's above it.
    const sum = (k: "sent" | "prospects" | "replies" | "humanReplies" | "positive" | "bounces") =>
      merged.reduce((t, r) => t + r[k], 0);

    return NextResponse.json({
      rows: merged,
      totals: {
        sent: sum("sent"),
        prospects: sum("prospects"),
        replies: sum("replies"),
        humanReplies: sum("humanReplies"),
        positive: sum("positive"),
        bounces: sum("bounces"),
      },
      count: rows.length,
    });
  } catch (error) {
    console.error("[api/analytics/clients]", error);
    return NextResponse.json({ error: "Failed to load clients" }, { status: 500 });
  }
}
