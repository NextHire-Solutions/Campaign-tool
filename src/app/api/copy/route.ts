import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase/server";
import { resolveFilters, toISODate } from "@/lib/analytics/query-params.ts";
import { resolvePlatformScope } from "@/lib/analytics/platform-scope.ts";
import { COPY_DIMENSION_KEYS, isCopyDimension } from "@/lib/analytics/copy-dimensions.ts";

/*
 * Copy performance (spec §6.1), grouped by ONE OR MORE dimensions.
 *
 * The screenshot's control is `Dimension: [picker] [chip ✕] [+ Add Dimension]`,
 * so the grouping is a SET, not a single choice, and the number of value
 * combinations is not knowable in SQL ahead of time. This route therefore asks
 * the database for per-step rows with their tags attached and forms the
 * combinations here.
 *
 * That is the app's one exemption from "aggregate in SQL", and it is bounded on
 * purpose: the row count is the number of sequence steps with volume in range
 * (233 today) and grows with campaigns, not with sending. The per-day stats
 * behind every row are still summed in SQL, so the PostgREST 1000-row cap this
 * rule exists to dodge is not reachable by data growth.
 */

export const dynamic = "force-dynamic";

const TEAM_ID = () => Number(process.env.EMAILBISON_TEAM_ID || 2);

interface StepRow {
  sequence_step_id: number;
  campaign_id: number;
  campaign_name: string | null;
  offer_id: string | null;
  subject: string | null;
  sent: number;
  replies: number;
  positive: number;
  bounced: number;
  meetings: number;
  tags: Record<string, string>;
}

const UNTAGGED = "Untagged";

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("dimensions") ?? "subject_line";
  const dimensions = raw.split(",").map((d) => d.trim()).filter(Boolean);

  if (!dimensions.length || !dimensions.every(isCopyDimension)) {
    return NextResponse.json(
      { error: `dimensions must be a comma-separated subset of: ${COPY_DIMENSION_KEYS.join(", ")}` },
      { status: 400 },
    );
  }

  let filters;
  try {
    filters = resolveFilters(request.nextUrl.searchParams, toISODate(new Date()));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid filters" },
      { status: 400 },
    );
  }

  const offerId = request.nextUrl.searchParams.get("offer_id");

  const scope = {
    p_team_id: TEAM_ID(),
    p_from: filters.from,
    p_to: filters.to,
    p_client_ids: filters.clientIds.length ? filters.clientIds : null,
    p_campaign_ids: filters.campaignIds.length ? filters.campaignIds : null,
  };

  /*
   * INSTANTLY'S COPY TOO. This read 548 EmailBison steps and ignored 1,376
   * Instantly ones — 28% coverage of a signal whose whole job is finding copy
   * that never varies, and Instantly is where the finding is: 64 of its
   * campaigns sent 88,609 emails in 90 days on copy with no variation at all.
   *
   * A campaign filter takes Instantly out of scope for the same reason it does
   * everywhere else (platform-scope.ts): campaign ids are EmailBison integers,
   * so a selection containing one cannot contain an Instantly campaign.
   */
  const platformScope = resolvePlatformScope({
    platforms: filters.platforms,
    campaignIds: filters.campaignIds,
  });
  const wantsInstantly =
    filters.campaignIds.length === 0 &&
    (filters.platforms.length === 0 || filters.platforms.includes("instantly"));

  const [{ data, error }, spintax, instantlySpintax] = await Promise.all([
    getSupabase().rpc("analytics_copy_steps", scope),
    /*
     * Same scope, deliberately: a campaign flagged for unvaried copy has to be
     * one this tab is already showing, or the flag points at something the
     * reader cannot see.
     */
    platformScope.emailbison
      ? getSupabase().rpc("analytics_spintax_campaigns", scope)
      : Promise.resolve({ data: [], error: null }),
    wantsInstantly
      ? getSupabase().rpc("analytics_instantly_spintax_campaigns", {
          p_team_id: TEAM_ID(),
          p_from: filters.from,
          p_to: filters.to,
          p_client_ids: filters.clientIds.length ? filters.clientIds : null,
        })
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (spintax.error) {
    return NextResponse.json({ error: spintax.error.message }, { status: 500 });
  }
  if (instantlySpintax.error) {
    return NextResponse.json({ error: instantlySpintax.error.message }, { status: 500 });
  }

  const steps = ((data ?? []) as StepRow[]).filter(
    (s) => !offerId || s.offer_id === offerId,
  );

  interface Member {
    id: number;
    subject: string | null;
    campaign: string | null;
    sent: number;
    replies: number;
    positive: number;
    bounced: number;
    reply_rate: number | null;
    positive_rate: number | null;
    bounce_rate: number | null;
  }
  interface Bucket {
    key: string;
    values: string[];
    steps: number;
    sent: number;
    replies: number;
    positive: number;
    bounced: number;
    /*
     * Campaign-level, not step-level: a meeting belongs to the conversation,
     * not to which email in the sequence started it. Summed per bucket, which
     * is the level the number is actually true at.
     */
    meetings: number;
    untagged: boolean;
    /*
     * The actual emails behind the row. "Question: 2.68% positive" is an
     * abstraction nobody can check or act on; the subjects underneath are the
     * thing you actually rewrite, so they travel with the aggregate rather than
     * needing a second request.
     *
     * Bounded by first-email steps with volume (85), so shipping them all costs
     * nothing.
     */
    members: Member[];
  }
  const buckets = new Map<string, Bucket>();

  for (const step of steps) {
    /*
     * A step missing a tag on a selected dimension becomes "Untagged" rather
     * than being dropped. Dropping it would quietly remove its volume from the
     * table while the totals elsewhere still counted it, and the reader would
     * have no way to see that the comparison was partial.
     */
    const values = dimensions.map((d) => step.tags?.[d] ?? UNTAGGED);
    const key = values.join(" › ");

    const bucket = buckets.get(key) ?? {
      key,
      values,
      steps: 0,
      sent: 0,
      replies: 0,
      positive: 0,
      bounced: 0,
      meetings: 0,
      untagged: values.includes(UNTAGGED),
      members: [],
    };
    bucket.members.push({
      id: step.sequence_step_id,
      subject: step.subject,
      campaign: step.campaign_name,
      sent: Number(step.sent) || 0,
      replies: Number(step.replies) || 0,
      positive: Number(step.positive) || 0,
      bounced: Number(step.bounced) || 0,
      reply_rate: Number(step.sent) > 0 ? Number(step.replies) / Number(step.sent) : null,
      positive_rate:
        Number(step.replies) > 0 ? Number(step.positive) / Number(step.replies) : null,
      bounce_rate: Number(step.sent) > 0 ? Number(step.bounced) / Number(step.sent) : null,
    });
    bucket.steps += 1;
    bucket.sent += Number(step.sent) || 0;
    bucket.replies += Number(step.replies) || 0;
    bucket.positive += Number(step.positive) || 0;
    bucket.bounced += Number(step.bounced) || 0;
    /*
     * Campaign-level, and safe to sum here only because the RPC returns exactly
     * one row per campaign (step_order = 1, non-variant). If it ever returned
     * several first steps for one campaign this would double-count while
     * sent/replies stayed right — which is why the constraint lives in the
     * query rather than being assumed here.
     */
    bucket.meetings += Number(step.meetings) || 0;
    buckets.set(key, bucket);
  }

  const rows = [...buckets.values()]
    .map((b) => ({
      ...b,
      members: b.members.sort((x, y) => y.sent - x.sent),
      // NULL, never 0, when nothing was sent — "no data" and "0%" are different
      // facts and DASH is how the first one reaches the DOM.
      reply_rate: b.sent > 0 ? b.replies / b.sent : null,
      positive_rate: b.replies > 0 ? b.positive / b.replies : null,
      bounce_rate: b.sent > 0 ? b.bounced / b.sent : null,
    }))
    /*
     * §6.1: "Sorted by Positive % by default — the column that matters most."
     *
     * It sorted by volume, which put the medal winner in third place: Direct
     * takes gold at 5.26% while Question sat on top with twice the sends and
     * 2.08%. The whole point of the table is which copy WORKS, not which was
     * sent most.
     *
     * Rows with no positive rate yet sink rather than float: a null is "not
     * enough replies to say", and sorting it above a measured 5% would put the
     * least-known value in the position that reads as best. Volume breaks ties,
     * so equal rates still order sensibly.
     */
    .sort((a, b) => {
      /*
       * Untagged always sinks, whatever its rate. It is a gap in the data, not
       * a way of writing — the same reason it cannot win a medal. Sorting by
       * rate alone put it top of the table at 25% off four replies, which is
       * the "smallest sample wins" failure the medal floor exists to prevent,
       * except in the position that reads as the answer.
       */
      if (a.untagged !== b.untagged) return a.untagged ? 1 : -1;
      const ar = a.positive_rate ?? -1;
      const br = b.positive_rate ?? -1;
      return br === ar ? b.sent - a.sent : br - ar;
    });

  const taggedSent = steps
    .filter((s) => dimensions.every((d) => s.tags?.[d]))
    .reduce((sum, s) => sum + (Number(s.sent) || 0), 0);
  const totalSent = steps.reduce((sum, s) => sum + (Number(s.sent) || 0), 0);

  return NextResponse.json({
    dimensions,
    from: filters.from,
    to: filters.to,
    rows,
    coverage: {
      tagged_sent: taggedSent,
      total_sent: totalSent,
      tagged_steps: steps.filter((s) => dimensions.every((d) => s.tags?.[d])).length,
      total_steps: steps.length,
    },
    /*
     * Both platforms in one list, each row naming its own — sorted by volume so
     * the biggest unvaried sender is first regardless of which platform it is
     * on, which is the question this card answers.
     */
    spintax: ([
      ...((spintax.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
        ...r,
        platform: "emailbison",
      })),
      ...((instantlySpintax.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
        ...r,
        platform: "instantly",
      })),
    ] as Array<Record<string, unknown>>).sort(
      (a, b) => Number(b.sent ?? 0) - Number(a.sent ?? 0),
    ),
  });
}
