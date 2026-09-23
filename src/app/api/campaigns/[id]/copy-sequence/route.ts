import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { applyCopy, planCopy } from "@/lib/campaigns/copy-sequence.ts";

/*
 * Copy a sequence into this campaign (spec §9.4).
 *
 * `[id]` is the TARGET — the campaign being changed — because that is what the
 * audit trail hangs off and what the confirmation must name.
 *
 * POST previews by default and only writes when `apply: true`, the same
 * dry-run-first discipline as the sync scripts and the client rematch. Here it
 * is not a convenience: Replace deletes the target's emails before creating the
 * new ones, and EmailBison has no way to undo that.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const TEAM_ID = () => Number(process.env.EMAILBISON_TEAM_ID || 2);

const Body = z.object({
  /*
   * Coerced, because the campaign list this id comes from is the
   * `campaigns_unified` view, whose id column is text — so a perfectly good
   * EmailBison id arrives as "297". Requiring a number here rejected every
   * copy the UI attempted. Coercion accepts "297" and still rejects an
   * Instantly uuid, which is the case that genuinely cannot be a source.
   */
  sourceCampaignId: z.coerce.number().int().positive(),
  mode: z.enum(["replace", "append"]),
  includeVariants: z.boolean().default(true),
  // §9.4 lists copy tags alongside variants and attachments. Defaults on: a
  // sequence copied without its dimensions drops out of the Copy & Offer
  // analysis, which is the analysis that identified it as worth copying.
  includeCopyTags: z.boolean().default(true),
  includeAttachments: z.boolean().default(true),
  apply: z.boolean().default(false),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(
    process.env.AUTH_SECRET ?? "",
    cookieStore.get(AUTH_COOKIE)?.value,
  );
  if (!session?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const targetId = Number(id);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 });
  }

  const raw = await request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    /*
     * Name the field. "Invalid request" was reported from the product as
     * "Copy a sequence from doesn't work", and the screenshot could not say
     * why: the route knew which field it had rejected and put it in `detail`,
     * which the dialog throws away. A 400 a user can read is the difference
     * between a bug report and a fix.
     */
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".") || "body";
    const received = raw === null
      ? "the request body was not valid JSON"
      : `received ${JSON.stringify((raw as Record<string, unknown>)?.[String(issue?.path[0])])}`;
    return NextResponse.json(
      {
        error: `Invalid request: ${field} — ${issue?.message ?? "failed validation"} (${received})`,
        detail: parsed.error.flatten(),
      },
      { status: 400 },
    );
  }

  const { sourceCampaignId, mode, includeVariants, includeAttachments, includeCopyTags, apply } =
    parsed.data;

  if (sourceCampaignId === targetId) {
    return NextResponse.json(
      { error: "A campaign cannot copy its sequence into itself." },
      { status: 400 },
    );
  }

  const teamId = TEAM_ID();
  const options = { includeVariants, includeAttachments, includeCopyTags };

  try {
    if (!apply) {
      return NextResponse.json({
        preview: true,
        plan: await planCopy(sourceCampaignId, targetId, mode, options, teamId),
      });
    }

    const outcome = await applyCopy(
      sourceCampaignId,
      targetId,
      mode,
      options,
      session.email,
      teamId,
    );

    if (!outcome.ok) {
      return NextResponse.json(outcome, {
        // 500 rather than 502 when the target was left without a sequence: this
        // is not "the upstream said no", it is "we broke something and it needs
        // a human". The response says so and points at the Activity tab.
        status: outcome.targetLeftEmpty ? 500 : 502,
      });
    }

    return NextResponse.json(outcome);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
