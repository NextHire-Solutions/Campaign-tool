import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Picker options for the filter bar.
 *
 * Cached for 5 minutes: it's identical for every view, gets hit on every page
 * load, and the underlying entity list changes on a 30-minute sync cadence at
 * most. Private, because it names the client roster.
 */
export async function GET() {
  const teamId = Number(process.env.EMAILBISON_TEAM_ID || 2);
  const sb = getSupabase();

  const [campaigns, clients, mappings, instantlyCampaigns, instantlyMappings] = await Promise.all([
    sb.from("campaigns")
      .select("id, name, lifetime_emails_sent")
      .eq("team_id", teamId)
      .order("lifetime_emails_sent", { ascending: false }),
    sb.from("clients").select("id, name").eq("team_id", teamId).order("name"),
    sb.from("campaign_clients").select("campaign_id, excluded"),
    /*
     * INSTANTLY'S CAMPAIGNS TOO. The picker offered 167 campaigns and none of
     * them Instantly's, so an analytics view could be scoped to one EmailBison
     * campaign and never to one of the 318 on the other platform — a filter
     * that silently covered half the estate.
     */
    sb.from("instantly_campaigns")
      .select("id, name, emails_sent")
      .eq("team_id", teamId)
      .is("archived_at", null)
      .order("emails_sent", { ascending: false, nullsFirst: false }),
    sb.from("instantly_campaign_clients").select("campaign_id, excluded"),
  ]);

  // Excluded campaigns are omitted from the picker: they're excluded from every
  // number, so offering them as a filter would let you select a campaign and
  // get an empty dashboard with no explanation.
  const excluded = new Set(
    (mappings.data ?? []).filter((m) => m.excluded).map((m) => m.campaign_id),
  );
  const instantlyExcluded = new Set(
    ((instantlyMappings.data ?? []) as Array<{ campaign_id: string; excluded: boolean }>)
      .filter((m) => m.excluded)
      .map((m) => m.campaign_id),
  );

  return NextResponse.json(
    {
      /*
       * Both platforms, sorted together by volume so the biggest campaign is
       * first regardless of where it runs. The Instantly ones are LABELLED,
       * because two campaigns can share a client and a near-identical name
       * across platforms and the id alone is not readable.
       */
      campaigns: [
        ...(campaigns.data ?? [])
          .filter((c) => !excluded.has(c.id))
          .map((c) => ({
            value: String(c.id),
            label: c.name,
            hint: (c.lifetime_emails_sent ?? 0).toLocaleString("en-US"),
            sent: c.lifetime_emails_sent ?? 0,
          })),
        ...((instantlyCampaigns.data ?? []) as Array<{ id: string; name: string; emails_sent: number | null }>)
          .filter((c) => !instantlyExcluded.has(c.id))
          .map((c) => ({
            value: c.id,
            label: `${c.name} · Instantly`,
            hint: (c.emails_sent ?? 0).toLocaleString("en-US"),
            sent: c.emails_sent ?? 0,
          })),
      ]
        .sort((a, b) => b.sent - a.sent)
        .map(({ sent: _sent, ...option }) => option),
      clients: (clients.data ?? []).map((c) => ({
        value: c.id,
        label: c.name,
      })),
    },
    { headers: { "Cache-Control": "private, max-age=300" } },
  );
}
