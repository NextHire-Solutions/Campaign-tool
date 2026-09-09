import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { createEmailBisonClient } from "@/lib/emailbison/client.ts";
import { getSupabase } from "@/lib/supabase/server";

/*
 * Which inboxes are currently sending for this campaign.
 *
 * Client feedback: "can we show under inboxes which ones are currently
 * assigned?" — the assign dialog offered pools to attach without ever saying
 * what was already there, so there was no way to tell an addition from a
 * no-op, or to notice a campaign was sending from the wrong pool.
 *
 * READ FROM EMAILBISON, NOT THE CACHE. Nothing here stores campaign→inbox
 * membership: sender_emails knows every inbox and campaign_lead_sends knows
 * which ones have SENT, which is a different and older fact. A campaign
 * assigned a pool an hour ago has sent from none of it yet.
 *
 * The tags come from our cache and are joined on afterwards, so the answer can
 * be phrased in the same pool names the dialog offers.
 */

export const dynamic = "force-dynamic";
// ~45 pages for a large campaign, one page per 15 inboxes.
export const maxDuration = 120;

const TEAM_ID = () => Number(process.env.EMAILBISON_TEAM_ID || 2);

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const campaignId = Number(id);
  if (!Number.isInteger(campaignId) || campaignId <= 0) {
    return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 });
  }

  const store = await cookies();
  const session = await verifySessionToken(
    process.env.AUTH_SECRET ?? "",
    store.get(AUTH_COOKIE)?.value,
  );
  if (!session?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const eb = createEmailBisonClient();
    const attached = await eb.getCampaignSenderEmails(campaignId);
    const ids = attached.map((s) => s.id).filter(Boolean);

    /*
     * Group by the pool tag, because that is the vocabulary the assign dialog
     * speaks. "531 inboxes" says nothing useful; "Nicole Pool 531" says whether
     * the right pool is on it.
     */
    const byTag = new Map<string, number>();
    if (ids.length) {
      const sb = getSupabase();
      const { data } = await sb
        .from("sender_emails")
        .select("id, tags, status")
        .eq("team_id", TEAM_ID())
        .in("id", ids.slice(0, 1000));
      for (const row of (data ?? []) as Array<{ tags: string[] | null }>) {
        for (const tag of row.tags ?? []) {
          byTag.set(tag, (byTag.get(tag) ?? 0) + 1);
        }
      }
    }

    return NextResponse.json({
      total: attached.length,
      connected: attached.filter((s) => s.status === "Connected").length,
      tags: [...byTag.entries()]
        .map(([tag, inboxes]) => ({ tag, inboxes }))
        .sort((a, b) => b.inboxes - a.inboxes),
    });
  } catch (error) {
    console.error("[api/campaigns/inboxes]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not read the inboxes" },
      { status: 500 },
    );
  }
}
