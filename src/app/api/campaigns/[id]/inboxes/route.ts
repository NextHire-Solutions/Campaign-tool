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

    /*
     * A FAST PATH FOR THE HEADLINE NUMBER.
     *
     * The full answer walks ~45 pages of EmailBison and takes 12.6 SECONDS on a
     * 662-inbox campaign, because nothing here stores campaign-to-inbox
     * membership. But the count alone is one page — 0.76s — since it rides on
     * `meta.total`.
     *
     * So the dialog asks for the count first and shows it almost immediately,
     * then fills in the connection states, the pool breakdown and the list when
     * the walk finishes. Sixteen times faster to the number people actually
     * came for, and the slow part no longer blocks it.
     */
    if (_request.nextUrl.searchParams.get("summary") === "1") {
      return NextResponse.json({ total: await eb.getCampaignSenderEmailCount(campaignId) });
    }

    const attached = await eb.getCampaignSenderEmails(campaignId);
    const ids = attached.map((s) => s.id).filter(Boolean);

    /*
     * Group by the pool tag, because that is the vocabulary the assign dialog
     * speaks. "531 inboxes" says nothing useful; "Nicole Pool 531" says whether
     * the right pool is on it.
     */
    const byTag = new Map<string, number>();
    /*
     * ...AND the mailboxes themselves. Counts answer "is the right pool on
     * this campaign"; they do not answer "which inboxes are sending for it",
     * which is the question actually asked. Both are cheap here because the
     * EmailBison walk has already happened.
     */
    const vendorById = new Map<number, string | null>();

    if (ids.length) {
      const sb = getSupabase();
      /*
       * Chunked: `.in()` on ~660 ids is fine, but a campaign can carry more
       * than the 1,000 rows PostgREST will return, and a silent truncation here
       * would drop inboxes from a list whose whole job is to be complete
       * (rule 7).
       */
      for (let i = 0; i < ids.length; i += 500) {
        const { data } = await sb
          .from("sender_emails")
          .select("id, tags, vendor")
          .eq("team_id", TEAM_ID())
          .in("id", ids.slice(i, i + 500));
        for (const row of (data ?? []) as Array<{
          id: number;
          tags: string[] | null;
          vendor: string | null;
        }>) {
          vendorById.set(row.id, row.vendor);
          for (const tag of row.tags ?? []) {
            byTag.set(tag, (byTag.get(tag) ?? 0) + 1);
          }
        }
      }
    }

    return NextResponse.json({
      total: attached.length,
      connected: attached.filter((s) => s.status === "Connected").length,
      tags: [...byTag.entries()]
        .map(([tag, inboxes]) => ({ tag, inboxes }))
        .sort((a, b) => b.inboxes - a.inboxes),
      inboxes: attached
        .map((s) => ({
          id: s.id,
          email: s.email,
          status: s.status ?? null,
          vendor: vendorById.get(s.id) ?? null,
          dailyLimit: s.daily_limit ?? null,
        }))
        // Broken ones first: an assigned inbox that cannot connect is the only
        // row in this list anyone needs to act on.
        .sort((a, b) => {
          const bad = (x: { status: string | null }) => (x.status === "Connected" ? 1 : 0);
          return bad(a) - bad(b) || (a.email ?? "").localeCompare(b.email ?? "");
        }),
    });
  } catch (error) {
    console.error("[api/campaigns/inboxes]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not read the inboxes" },
      { status: 500 },
    );
  }
}
