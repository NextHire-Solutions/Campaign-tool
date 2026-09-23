import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  aliases: z.array(z.string().min(1)).max(20).optional(),
  matchMode: z.enum(["contains", "prefix", "exact"]).optional(),
  active: z.boolean().optional(),
  /*
   * The authority. `active` is kept for older callers and a database trigger
   * keeps the two in step, so writing either one is safe — but only `status`
   * can say WHICH kind of inactive a client is, and the client's rule ("paused
   * or churned -> pause the campaigns, turn the portal off") needs that.
   */
  status: z.enum(["onboarding", "active", "paused", "churned"]).optional(),
});

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid update" }, { status: 400 });
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.name !== undefined) patch.name = parsed.data.name.trim();
  if (parsed.data.aliases !== undefined) patch.aliases = parsed.data.aliases;
  if (parsed.data.matchMode !== undefined) patch.match_mode = parsed.data.matchMode;
  if (parsed.data.active !== undefined) patch.active = parsed.data.active;
  if (parsed.data.status !== undefined) patch.status = parsed.data.status;

  const { data, error } = await getSupabase()
    .from("clients").update(patch).eq("id", id).select().single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ client: data });
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  // campaign_clients.client_id is ON DELETE SET NULL, so the campaigns fall
  // back to Unassigned rather than disappearing. Deleting a client must never
  // delete campaign data.
  const { error } = await getSupabase().from("clients").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
