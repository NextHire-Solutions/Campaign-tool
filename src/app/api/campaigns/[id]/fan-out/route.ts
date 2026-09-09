import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { fanOutToClients } from "@/lib/campaigns/fan-out.ts";

/*
 * Build one campaign per client from a template campaign.
 *
 * Creates real campaigns in EmailBison, so it carries the same contract as
 * every other write here: session-auth, audit trail, explicit confirmation, and
 * per-target results because a fan-out genuinely half-succeeds.
 */

export const dynamic = "force-dynamic";
// Per client: a duplicate, a rename, a step read and up to three inbox writes.
// Ten clients is ~60 sequential calls; the platform default would abandon the
// batch midway with some campaigns built and the caller told nothing.
export const maxDuration = 300;

const TEAM_ID = () => Number(process.env.EMAILBISON_TEAM_ID || 2);

const Body = z.object({
  clientIds: z.array(z.string().uuid()).min(1).max(50),
  /*
   * `{client}` is substituted per target. Without the token the client name is
   * prefixed instead, so a template can never produce N identical names — which
   * would be indistinguishable in every list in the product.
   */
  nameTemplate: z.string().trim().min(1).max(200),
  copyInboxes: z.boolean().default(true),
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

  const store = await cookies();
  const session = await verifySessionToken(
    process.env.AUTH_SECRET ?? "",
    store.get(AUTH_COOKIE)?.value,
  );
  if (!session?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const missingConfirm = parsed.error.issues.some((i) => i.path[0] === "confirm");
    return NextResponse.json(
      {
        error: missingConfirm
          ? "Creating campaigns must be confirmed. Re-send with confirm: true."
          : "Invalid request",
        detail: parsed.error.flatten(),
      },
      { status: missingConfirm ? 428 : 400 },
    );
  }

  const summary = await fanOutToClients(
    sourceId,
    [...new Set(parsed.data.clientIds)],
    parsed.data.nameTemplate,
    { copyInboxes: parsed.data.copyInboxes },
    session.email,
    TEAM_ID(),
  );

  return NextResponse.json(summary, { status: summary.failed ? 207 : 200 });
}
