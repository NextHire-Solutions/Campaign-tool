import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { removeLeads } from "@/lib/campaigns/lead-membership.ts";
import { removeInstantlyLeads } from "@/lib/campaigns/instantly-lead-membership.ts";
import { platformOfId } from "@/lib/campaigns/campaign-id.ts";

/*
 * Remove selected leads from a campaign.
 *
 * This stops real prospects receiving the rest of a sequence, so it follows the
 * same contract as every other campaign write: session-authenticated, named in
 * the audit log, explicitly confirmed, and honest about partial success.
 */

export const dynamic = "force-dynamic";
// 6,000 leads is 12 chunked calls plus the local marking. Comfortably inside
// this, but the platform default would cut a large removal off midway and tell
// the caller nothing about how far it got.
export const maxDuration = 300;

const TEAM_ID = () => Number(process.env.EMAILBISON_TEAM_ID || 2);

const Body = z.object({
  /*
   * Capped well above any realistic selection but not unbounded: the ids are
   * chunked server-side anyway, and an unbounded array is a way to hold a
   * request open for minutes.
   */
  /*
   * Numbers for EmailBison, uuid strings for Instantly. Accepted as either and
   * validated against the campaign's own platform below — a uuid sent at an
   * EmailBison campaign is a caller bug, not something to coerce.
   */
  leadIds: z.array(z.union([z.number().int().positive(), z.string().min(1)]))
    .min(1)
    .max(20000),
  /*
   * Required, always. Unlike pause, this has no undo: EmailBison offers no
   * "restore removed leads" call, and re-adding is a separate deliberate act.
   * The client sends it only from a dialog that names the campaign and the
   * exact count, so a mis-wired fetch cannot empty a campaign.
   */
  confirm: z.literal(true),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const platform = platformOfId(id);
  if (!platform) {
    return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 });
  }

  const cookieStore = await cookies();
  const session = await verifySessionToken(
    process.env.AUTH_SECRET ?? "",
    cookieStore.get(AUTH_COOKIE)?.value,
  );
  // The proxy gates this path already; reading the session here is for the
  // audit trail, which is worthless if it cannot name who acted.
  if (!session?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const missingConfirm = parsed.error.issues.some((i) => i.path[0] === "confirm");
    return NextResponse.json(
      {
        error: missingConfirm
          ? "Removing leads cannot be undone and must be confirmed. Re-send with confirm: true."
          : "Invalid request",
        detail: parsed.error.flatten(),
      },
      // 428 for the unconfirmed case, matching /api/campaigns/actions.
      { status: missingConfirm ? 428 : 400 },
    );
  }

  /*
   * De-duplicated before anything is sent. A double-clicked "select all" can
   * put the same id in twice, and the reported `attempted` count has to be the
   * number of leads, not the length of an array.
   */
  const leadIds = [...new Set(parsed.data.leadIds)];

  if (platform === "instantly") {
    /*
     * Ids must MATCH THE PLATFORM. Instantly lead ids are uuids; a number here
     * means the caller built the list against the wrong campaign, and sending
     * it would delete whatever happened to match. Refused rather than filtered:
     * a partly-wrong list is not a request anyone made.
     */
    if (leadIds.some((v) => typeof v !== "string")) {
      return NextResponse.json(
        { error: "Instantly lead ids are uuids; numeric ids were sent." },
        { status: 400 },
      );
    }
    const result = await removeInstantlyLeads(
      id,
      leadIds as string[],
      session.email,
      TEAM_ID(),
    );
    return NextResponse.json(result, { status: result.ok ? 200 : 207 });
  }

  if (leadIds.some((v) => typeof v !== "number")) {
    return NextResponse.json(
      { error: "EmailBison lead ids are integers; non-numeric ids were sent." },
      { status: 400 },
    );
  }

  const result = await removeLeads(
    Number(id),
    leadIds as number[],
    session.email,
    TEAM_ID(),
  );

  return NextResponse.json(
    result,
    // 207 when EmailBison accepted some chunks and refused others: a blanket
    // 200 would let a caller that only checks response.ok report a half-done
    // removal as done.
    { status: result.ok ? 200 : 207 },
  );
}
