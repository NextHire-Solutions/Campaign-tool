import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { platformOfId } from "@/lib/campaigns/campaign-id.ts";
import { findUnsupported, removeUnsupported } from "@/lib/campaigns/unsupported-servers.ts";
const analyticsTeamId = () => Number(process.env.EMAILBISON_TEAM_ID || 2);

/*
 * Remove Unsupported Mail Servers (1 Oct).
 *
 * GET  → how many of the campaign's leads are on Proofpoint, Mimecast,
 *        Barracuda, Zoho or a custom server, per server. Reads only.
 * POST { confirm: true } → removes them from this campaign. Found again at the
 *        moment of removal; counted again afterwards.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const platform = platformOfId(id);
  if (!platform) return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 });
  try {
    return NextResponse.json({ platform, ...(await findUnsupported(platform, id)) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the campaign's leads" }, { status: 502 });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const platform = platformOfId(id);
  if (!platform) return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 });
  const session = await verifySessionToken(process.env.AUTH_SECRET ?? "", (await cookies()).get(AUTH_COOKIE)?.value);
  if (!session?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { confirm?: unknown } | null;
  if (body?.confirm !== true) {
    return NextResponse.json({ error: "Removing leads cannot be undone and must be confirmed. Re-send with confirm: true." }, { status: 428 });
  }
  try {
    const r = await removeUnsupported(platform, id, session.email, analyticsTeamId());
    return NextResponse.json(r, { status: r.ok ? 200 : 207 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not remove the leads" }, { status: 502 });
  }
}
