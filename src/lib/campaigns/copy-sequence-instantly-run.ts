import { NextResponse } from "next/server";

import { createInstantlyClient } from "@/lib/instantly/client.ts";
import { getSupabase } from "@/lib/supabase/server";
import {
  planInstantlyCopy,
  stepsOf,
  type CopyMode,
} from "@/lib/campaigns/copy-sequence-instantly.ts";

/*
 * The Instantly half of POST /api/campaigns/[id]/copy-sequence.
 *
 * Separate from the route so the route stays a dispatcher, and separate from
 * the pure planner so the planner can be tested without a network.
 *
 * Previewing costs two reads and writes nothing. Applying is a single PATCH:
 * Instantly holds the whole sequence in one field, so unlike EmailBison's
 * Replace — which deletes the old steps and then creates the new ones, and can
 * strand a campaign with neither — this cannot half-apply. Either the new
 * sequence is there or the old one is untouched.
 */

const TEAM_ID = () => Number(process.env.EMAILBISON_TEAM_ID || 2);

interface Input {
  sourceId: string;
  targetId: string;
  mode: CopyMode;
  apply: boolean;
  actor: string;
}

export async function instantlyCopy({ sourceId, targetId, mode, apply, actor }: Input) {
  const client = createInstantlyClient();

  let source: Record<string, unknown>;
  let target: Record<string, unknown>;
  try {
    [source, target] = await Promise.all([
      client.getCampaign(sourceId),
      client.getCampaign(targetId),
    ]);
  } catch (error) {
    /*
     * A 404 here is the ordinary case, not a server fault: the cached campaign
     * list can outlive a campaign deleted in Instantly, so the picker can
     * offer one that is already gone. Say which, rather than "Instantly 404".
     */
    const status = (error as { statusCode?: number } | null)?.statusCode;
    if (status === 404) {
      return NextResponse.json(
        { error: "One of those campaigns no longer exists in Instantly. Refresh and try again." },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }

  const plan = planInstantlyCopy({
    sourceId,
    sourceName: String(source.name ?? sourceId),
    sourceSequences: source.sequences as never,
    targetId,
    targetName: String(target.name ?? targetId),
    targetStatus: target.status as number | null,
    targetSequences: target.sequences as never,
    mode,
  });

  const blocking = plan.warnings.filter((w) => /no sequence steps to copy|into itself/.test(w));
  if (blocking.length) {
    return NextResponse.json({ error: blocking[0], plan }, { status: 400 });
  }

  if (!apply) {
    // `sequences` is the PATCH body, not something a preview should ship.
    const { sequences: _body, ...rest } = plan;
    return NextResponse.json({ preview: true, plan: rest });
  }

  try {
    await client.updateCampaign(targetId, { sequences: plan.sequences });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
        // Nothing was deleted first, so the target still has whatever it had.
        targetLeftEmpty: false,
      },
      { status: 502 },
    );
  }

  /*
   * Read back rather than trust the write. The count that goes in the audit
   * log and on screen is the campaign's own, so a PATCH that silently kept
   * fewer steps than we sent cannot be reported as a success.
   */
  let confirmed = plan.steps.length;
  try {
    const after = await client.getCampaign(targetId);
    confirmed = stepsOf(after.sequences as never).length;
  } catch {
    /* the write succeeded; a failed read-back is not a failed copy */
  }

  const removed = mode === "replace" ? plan.removing.length : 0;
  try {
    await getSupabase().from("campaign_audit_log").insert({
      team_id: TEAM_ID(),
      campaign_id: null,
      campaign_name: plan.targetName,
      action: "copy-sequence",
      actor,
      detail: {
        platform: "instantly",
        mode,
        sourceId,
        sourceName: plan.sourceName,
        targetId,
        stepsCreated: confirmed,
        stepsRemoved: removed,
      },
    });
  } catch {
    /* the copy is done; failing to log it must not report a failure */
  }

  return NextResponse.json({
    ok: true,
    created: confirmed,
    deleted: removed,
    mode,
    targetName: plan.targetName,
  });
}
