import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const TEAM_ID = () => Number(process.env.EMAILBISON_TEAM_ID || 2);

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Clients plus their campaign counts, and the unassigned/ambiguous queue. */
export async function GET() {
  const sb = getSupabase();
  const teamId = TEAM_ID();

  const [clients, mappings, campaigns, instantlyMappings, instantlyCampaigns] = await Promise.all([
    sb.from("clients").select("id, name, slug, aliases, match_mode, active").eq("team_id", teamId).order("name"),
    sb.from("campaign_clients").select("campaign_id, client_id, match_method, matched_on, ambiguous, excluded"),
    sb.from("campaigns").select("id, name, status, lifetime_emails_sent").eq("team_id", teamId),
    /*
     * INSTANTLY'S MAPPINGS TOO. This counted EmailBison campaigns only, so
     * Bastion Realty South read 10 against a real 26 and The Keyes Company 9
     * against 38 — a client page understating most clients by more than half,
     * with nothing on screen to suggest it.
     */
    sb.from("instantly_campaign_clients").select("campaign_id, client_id, match_method, ambiguous, excluded"),
    sb.from("instantly_campaigns").select("id, name, status, emails_sent").eq("team_id", teamId).is("archived_at", null),
  ]);

  if (clients.error) {
    return NextResponse.json({ error: clients.error.message }, { status: 500 });
  }

  const byCampaign = new Map((mappings.data ?? []).map((m) => [m.campaign_id, m]));

  /*
   * Counted across BOTH platforms. `campaignCount` is the number of campaigns
   * a client has, and a client does not experience its Instantly work as a
   * separate business.
   */
  const counts = new Map<string, { total: number; manual: number; instantly: number }>();
  const tally = (
    rows: Array<{ client_id: string | null; excluded: boolean; match_method?: string }>,
    platform: "emailbison" | "instantly",
  ) => {
    for (const m of rows) {
      if (!m.client_id || m.excluded) continue;
      const c = counts.get(m.client_id) ?? { total: 0, manual: 0, instantly: 0 };
      c.total++;
      if (m.match_method === "manual") c.manual++;
      if (platform === "instantly") c.instantly++;
      counts.set(m.client_id, c);
    }
  };
  tally((mappings.data ?? []) as never[], "emailbison");
  tally((instantlyMappings.data ?? []) as never[], "instantly");

  // The unassigned queue: campaigns needing a human. Excluded ones are left out
  // deliberately -- they're a settled decision, not an outstanding task, and
  // leaving them in would mean the queue never reaches zero.
  const instantlyByCampaign = new Map(
    ((instantlyMappings.data ?? []) as Array<{ campaign_id: string }>).map((m) => [m.campaign_id, m]),
  );

  const unassigned = [
    ...(campaigns.data ?? []).map((c) => ({
      campaignId: String(c.id),
      platform: "emailbison" as const,
      name: c.name,
      status: c.status,
      lifetimeSent: c.lifetime_emails_sent ?? 0,
      mapping: byCampaign.get(c.id) as { excluded?: boolean; client_id?: string | null; ambiguous?: boolean } | undefined,
    })),
    /*
     * Instantly's unattributed campaigns belong in the same queue: the work of
     * assigning them is identical, and a queue that shows half of it reaches
     * zero while the job is unfinished.
     */
    ...((instantlyCampaigns.data ?? []) as Array<{ id: string; name: string; status: number; emails_sent: number | null }>).map((c) => ({
      campaignId: c.id,
      platform: "instantly" as const,
      name: c.name,
      status: { 0: "draft", 1: "active", 2: "paused", 3: "completed" }[c.status] ?? "error",
      lifetimeSent: c.emails_sent ?? 0,
      mapping: instantlyByCampaign.get(c.id) as { excluded?: boolean; client_id?: string | null; ambiguous?: boolean } | undefined,
    })),
  ]
    .filter(({ mapping }) => mapping && !mapping.excluded && (!mapping.client_id || mapping.ambiguous))
    .map(({ mapping: _mapping, ...rest }) => ({ ...rest, ambiguous: Boolean(_mapping!.ambiguous) }))
    .sort((a, b) => b.lifetimeSent - a.lifetimeSent);

  return NextResponse.json({
    clients: (clients.data ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      aliases: c.aliases ?? [],
      matchMode: c.match_mode,
      active: c.active,
      campaignCount: counts.get(c.id)?.total ?? 0,
      manualCount: counts.get(c.id)?.manual ?? 0,
      /* Of those, how many are Instantly's — so the split is visible. */
      instantlyCount: counts.get(c.id)?.instantly ?? 0,
    })),
    unassigned,
    excludedCount: (mappings.data ?? []).filter((m) => m.excluded).length,
  });
}

const createSchema = z.object({
  name: z.string().min(1).max(200),
  aliases: z.array(z.string().min(1)).max(20).optional(),
  matchMode: z.enum(["contains", "prefix", "exact"]).optional(),
});

export async function POST(request: NextRequest) {
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid client" }, { status: 400 });
  }

  const { data, error } = await getSupabase()
    .from("clients")
    .insert({
      team_id: TEAM_ID(),
      name: parsed.data.name.trim(),
      slug: slugify(parsed.data.name),
      aliases: parsed.data.aliases ?? [],
      match_mode: parsed.data.matchMode ?? "contains",
    })
    .select()
    .single();

  if (error) {
    const conflict = error.message.includes("duplicate") || error.code === "23505";
    return NextResponse.json(
      { error: conflict ? "A client with that name already exists" : error.message },
      { status: conflict ? 409 : 500 },
    );
  }
  return NextResponse.json({ client: data }, { status: 201 });
}
