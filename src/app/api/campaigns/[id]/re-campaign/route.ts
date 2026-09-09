import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { reCampaign } from "@/lib/campaigns/re-campaign.ts";

/*
 * Duplicate a campaign and load it with the people who never answered.
 *
 * GET previews the selection — how many leads would move — so the dialog can
 * state a real number before anything is created. POST does it.
 */

export const dynamic = "force-dynamic";
// Worst case is a duplicate, a rename, ~45 pages of inboxes, three attach calls
// and twelve chunked lead attaches. Comfortably inside this; the platform
// default would abandon a half-built campaign with the caller told nothing.
export const maxDuration = 300;

const TEAM_ID = () => Number(process.env.EMAILBISON_TEAM_ID || 2);

async function session() {
  const store = await cookies();
  return verifySessionToken(process.env.AUTH_SECRET ?? "", store.get(AUTH_COOKIE)?.value);
}

/** How many leads the default selection would move. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const campaignId = Number(id);
  if (!Number.isInteger(campaignId) || campaignId <= 0) {
    return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 });
  }
  if (!(await session())?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { getSupabase } = await import("@/lib/supabase/server");
  /*
   * Both numbers. `unresponsive` is who never answered; `available` is how many
   * of those EmailBison will actually accept — it refuses anyone still being
   * emailed by another sequence. Showing only the smaller number makes it look
   * like leads went missing; showing only the larger one promises a move that
   * will not happen. On campaign 55 they are 5,982 and 1,177.
   */
  const { data, error } = await getSupabase().rpc("analytics_recampaign_preview", {
    p_team_id: TEAM_ID(),
    p_campaign_id: campaignId,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const row = ((data ?? []) as Array<{ unresponsive: number; available: number }>)[0];
  return NextResponse.json({
    unresponsive: Number(row?.unresponsive ?? 0),
    available: Number(row?.available ?? 0),
  });
}

const Body = z.object({
  name: z.string().trim().min(1).max(200),
  /*
   * Whether to carry the source's inboxes across. A campaign with none cannot
   * send at all, so the default in the UI is on — but it is a choice, because
   * re-sequencing onto a different pool is a real thing to want.
   */
  copyInboxes: z.boolean().default(true),
  /*
   * Creating a campaign and loading thousands of leads into it is not something
   * a stray fetch should be able to do. It lands as a DRAFT, so nothing is sent
   * until someone separately resumes it.
   */
  confirm: z.literal(true),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sourceId = Number(id);
  if (!Number.isInteger(sourceId) || sourceId <= 0) {
    return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 });
  }

  const current = await session();
  if (!current?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const missingConfirm = parsed.error.issues.some((i) => i.path[0] === "confirm");
    return NextResponse.json(
      {
        error: missingConfirm
          ? "Creating a campaign must be confirmed. Re-send with confirm: true."
          : "Invalid request",
        detail: parsed.error.flatten(),
      },
      { status: missingConfirm ? 428 : 400 },
    );
  }

  const result = await reCampaign(
    sourceId,
    parsed.data.name,
    { copyInboxes: parsed.data.copyInboxes },
    current.email,
    TEAM_ID(),
  );

  /*
   * 207 when a campaign was created but not fully populated. It matters that
   * this is not a plain error: the campaign EXISTS and the caller has to know
   * its id to finish or delete it, which a 500 with no body would deny them.
   */
  const status = result.ok ? 200 : result.campaignId ? 207 : 400;
  return NextResponse.json(result, { status });
}
