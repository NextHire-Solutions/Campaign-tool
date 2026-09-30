import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { platformOfId } from "@/lib/campaigns/campaign-id.ts";
import { SequenceActionError, applySequenceAction, liveSequence, type SequenceAction } from "@/lib/campaigns/sequence-live.ts";
const analyticsTeamId = () => Number(process.env.EMAILBISON_TEAM_ID || 2);

/*
 * The live sequence with what each step may do, and the actions (1 Oct):
 * GET  → steps with canDelete / canToggle and the reason when not.
 * POST { key, action: "delete" | "turn-off" | "turn-on", confirm: true }
 */
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const platform = platformOfId(id);
  if (!platform) return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 });
  try {
    return NextResponse.json(await liveSequence(platform, id));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the sequence" }, { status: 502 });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const platform = platformOfId(id);
  if (!platform) return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 });
  const session = await verifySessionToken(process.env.AUTH_SECRET ?? "", (await cookies()).get(AUTH_COOKIE)?.value);
  if (!session?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { key?: unknown; action?: unknown; confirm?: unknown } | null;
  const key = typeof body?.key === "string" ? body.key : typeof body?.key === "number" ? String(body.key) : "";
  const action = body?.action;
  if (!key || (action !== "delete" && action !== "turn-off" && action !== "turn-on")) {
    return NextResponse.json({ error: "key and action (delete, turn-off or turn-on) are required." }, { status: 400 });
  }
  if (body?.confirm !== true) return NextResponse.json({ error: "Confirm the change: re-send with confirm: true." }, { status: 428 });
  try {
    return NextResponse.json(await applySequenceAction(platform, id, key, action as SequenceAction, session.email, analyticsTeamId()));
  } catch (e) {
    const status = e instanceof SequenceActionError ? e.status : 502;
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not change the sequence" }, { status });
  }
}
