import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { assignInboxesByTag, listInboxTags } from "@/lib/campaigns/inbox-assignment.ts";

/*
 * Assigning a tagged pool of inboxes to campaigns.
 *
 * GET lists the tags worth choosing from — read from our own cache of every
 * inbox's EmailBison tags, so a pool renamed or created upstream appears here
 * after the next sync-senders without a deploy.
 *
 * POST does the fan-out. It changes which mailboxes send for a campaign, so it
 * follows the same contract as every other campaign write: session-auth, named
 * in the audit log, confirmed, and honest about partial success.
 */

export const dynamic = "force-dynamic";
// 534 inboxes x 3 chunks x N campaigns, serial. A 20-campaign assignment is
// ~60 calls; the platform default would cut that off midway and leave some
// campaigns assigned and the caller told nothing.
export const maxDuration = 300;

const TEAM_ID = () => Number(process.env.EMAILBISON_TEAM_ID || 2);

async function requireSession() {
  const cookieStore = await cookies();
  return verifySessionToken(
    process.env.AUTH_SECRET ?? "",
    cookieStore.get(AUTH_COOKIE)?.value,
  );
}

export async function GET(request: NextRequest) {
  const session = await requireSession();
  if (!session?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  /*
   * The pools differ per platform — EmailBison's live on sender_emails, and
   * Instantly's come from its custom-tags resource (084). Returning one list
   * for both would offer a pool that does not exist on the platform being
   * assigned, and the assignment would then quietly match nothing.
   */
  const platform =
    request.nextUrl.searchParams.get("platform") === "instantly" ? "instantly" : "emailbison";
  return NextResponse.json({
    platform,
    tags: await listInboxTags(TEAM_ID(), platform),
  });
}

const Target = z.object({
  platform: z.enum(["emailbison", "instantly"]),
  id: z.string().min(1),
});

const Body = z.object({
  /*
   * Platform-qualified, because a campaign id alone spans two id spaces and
   * the two platforms assign inboxes by different mechanisms entirely —
   * EmailBison attaches, Instantly replaces the whole list.
   *
   * `campaignIds` still works and still means EmailBison.
   */
  targets: z.array(Target).min(1).max(500).optional(),
  campaignIds: z.array(z.number().int().positive()).min(1).max(500).optional(),
  tag: z.string().min(1).max(200),
  action: z.enum(["attach", "remove"]),
  /*
   * Required for both directions. Attaching changes who sends for a live
   * campaign and removing can leave one with no way to send at all, so neither
   * should be reachable by a mis-wired fetch.
   */
  confirm: z.literal(true),
});

export async function POST(request: NextRequest) {
  const session = await requireSession();
  if (!session?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const missingConfirm = parsed.error.issues.some((i) => i.path[0] === "confirm");
    return NextResponse.json(
      {
        error: missingConfirm
          ? "Changing a campaign's inboxes must be confirmed. Re-send with confirm: true."
          : "Invalid request",
        detail: parsed.error.flatten(),
      },
      { status: missingConfirm ? 428 : 400 },
    );
  }

  const { tag, action } = parsed.data;
  const targets =
    parsed.data.targets ??
    (parsed.data.campaignIds ?? []).map((id) => ({
      platform: "emailbison" as const,
      id: String(id),
    }));

  if (!targets.length) {
    return NextResponse.json(
      { error: "No campaigns given. Send `targets: [{platform, id}]`." },
      { status: 400 },
    );
  }

  // Deduplicated on the PAIR: the same number can be a valid id on both sides.
  const unique = [...new Map(targets.map((t) => [`${t.platform}:${t.id}`, t])).values()];

  const summary = await assignInboxesByTag(
    unique,
    tag,
    action,
    session.email,
    TEAM_ID(),
  );

  const failed = summary.results.filter((r) => !r.ok).length;

  return NextResponse.json(
    summary,
    // 207 when the fan-out half-succeeded: a blanket 200 would let a caller
    // that only checks response.ok report a partial assignment as done.
    { status: failed ? 207 : 200 },
  );
}
