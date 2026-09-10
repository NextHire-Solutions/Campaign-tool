import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase/server";
import { resolveFilters, toISODate } from "@/lib/analytics/query-params.ts";

/*
 * Offers (spec §6.2).
 *
 * "Offers — Zillow Flex, realtor.com VIP — are tracked as things in their own
 * right, not just as campaign names."
 *
 * This half of the tab works the moment an offer exists and a campaign is
 * attached; unlike the copy half it needs no per-step tagging first.
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

  const sb = getSupabase();
  const teamId = TEAM_ID();

  const [rows, offers, attached, sources] = await Promise.all([
    sb.rpc("analytics_offer_rows", {
      p_team_id: teamId,
      p_from: filters.from,
      p_to: filters.to,
      p_client_ids: filters.clientIds.length ? filters.clientIds : null,
      p_campaign_ids: filters.emailbisonCampaignIds.length ? filters.emailbisonCampaignIds : null,
    }),
    sb.from("offers").select("id, name, niche, active").eq("team_id", teamId).order("name"),
    sb.from("campaign_offers").select("campaign_id, offer_id"),
    // Which campaign's sequence represents each offer — the thing the one-click
    // deploy copies FROM.
    sb.rpc("analytics_offer_source", { p_team_id: teamId }),
  ]);

  const failed = rows.error ?? offers.error ?? attached.error ?? sources.error;
  if (failed) return NextResponse.json({ error: failed.message }, { status: 500 });

  const sourceBy = new Map(
    (sources.data ?? []).map((s: { offer_id: string }) => [s.offer_id, s]),
  );

  return NextResponse.json({
    from: filters.from,
    to: filters.to,
    rows: (rows.data ?? []).map((r: { offer_id: string }) => ({
      ...r,
      source: sourceBy.get(r.offer_id) ?? null,
    })),
    offers: offers.data ?? [],
    // Campaigns with no offer are the to-do list — the same shape as the
    // unassigned-campaign queue on the Clients page.
    attachedCount: (attached.data ?? []).length,
  });
}

const OfferBody = z.object({
  name: z.string().min(1).max(120),
  niche: z.string().max(120).optional().nullable(),
  /** Optional: seed the offer from a campaign's sequence straight away. */
  sourceCampaignId: z.number().int().positive().nullable().optional(),
  /** Attach these campaigns on creation, so a new group is never empty. */
  campaignIds: z.array(z.number().int().positive()).max(200).optional(),
});

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(
    process.env.AUTH_SECRET ?? "",
    cookieStore.get(AUTH_COOKIE)?.value,
  );
  if (!session?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = OfferBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid offer", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { data, error } = await getSupabase()
    .from("offers")
    .insert({
      team_id: TEAM_ID(),
      name: parsed.data.name.trim(),
      niche: parsed.data.niche?.trim() || null,
      source_campaign_id: parsed.data.sourceCampaignId ?? null,
    })
    .select("id, name, niche, active, source_campaign_id")
    .single();

  if (error) {
    // 23505 is the unique (team_id, name) index — a duplicate name is a user
    // mistake, not a server fault, and deserves its own message.
    return NextResponse.json(
      {
        error:
          error.code === "23505"
            ? `An offer called "${parsed.data.name}" already exists.`
            : error.message,
      },
      { status: error.code === "23505" ? 409 : 500 },
    );
  }

  if (parsed.data.campaignIds?.length && data) {
    await getSupabase()
      .from("campaign_offers")
      .upsert(
        parsed.data.campaignIds.map((campaignId) => ({
          campaign_id: campaignId,
          offer_id: data.id,
          actor: session.email,
          updated_at: new Date().toISOString(),
        })),
        { onConflict: "campaign_id" },
      );
  }

  return NextResponse.json({ offer: data }, { status: 201 });
}
