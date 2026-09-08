import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase/server";

/*
 * The campaign list, served from the Supabase cache — never from EmailBison.
 *
 * This is the speed decision that matters most on this page. A live fan-out
 * would be ~1 call per page of campaigns plus one per campaign for stats, on
 * every keystroke of the search box. Reading the cache is a single indexed
 * query, and the cache is at most 30 minutes stale for names and instantly
 * correct for status, because every action writes its result through.
 *
 * Filtering and counting both happen in SQL. Fetching 95 rows and filtering in
 * JS would work today and silently truncate at 1000 later — the PostgREST cap
 * this codebase has been bitten by before.
 */

export const dynamic = "force-dynamic";

const TEAM_ID = () => Number(process.env.EMAILBISON_TEAM_ID || 2);

export async function GET(request: NextRequest) {
  const sb = getSupabase();
  const teamId = TEAM_ID();
  const params = request.nextUrl.searchParams;

  const status = params.get("status") ?? "all";
  const search = (params.get("q") ?? "").trim();
  const clientId = params.get("client_id");
  const tag = params.get("tag");
  const limit = Math.min(Number(params.get("limit") ?? 200), 500);
  const offset = Math.max(Number(params.get("offset") ?? 0), 0);

  let query = sb
    .from("campaigns")
    .select(
      "id, name, status, type, tags, total_leads, lifetime_emails_sent, lifetime_unique_replies, completion_percentage, max_emails_per_day, eb_created_at, eb_updated_at",
      { count: "estimated" },
    )
    .eq("team_id", teamId)
    // Deleted upstream: kept for history, never offered as a choice.
    .is("deleted_at", null);

  if (status !== "all") query = query.eq("status", status);
  // `ilike` with a leading wildcard can't use a btree index, but at 95 rows
  // that is irrelevant; revisit with a trigram index if this grows.
  if (search) query = query.ilike("name", `%${search}%`);

  const [{ data: rows, error, count }, mappings, clients, counts, allTags] = await Promise.all([
    query.order("lifetime_emails_sent", { ascending: false, nullsFirst: false })
      .range(offset, offset + limit - 1),
    sb.from("campaign_clients").select("campaign_id, client_id, excluded, ambiguous"),
    sb.from("clients").select("id, name").eq("team_id", teamId),
    // One grouped read for the status pills, so their numbers describe the
    // whole workspace rather than the current page.
    sb.from("campaigns").select("status").eq("team_id", teamId).is("deleted_at", null),
    // Tags for the filter's own dropdown, read from the data rather than a
    // hardcoded list — a tag added in EmailBison must appear here without a
    // deploy, and one that no longer exists must stop being offered.
    sb.from("campaigns").select("tags").eq("team_id", teamId).is("deleted_at", null),
  ]);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const clientById = new Map((clients.data ?? []).map((c) => [c.id, c.name]));
  const mapByCampaign = new Map((mappings.data ?? []).map((m) => [m.campaign_id, m]));

  let items = (rows ?? []).map((c) => {
    const mapping = mapByCampaign.get(c.id);
    return {
      ...c,
      clientId: mapping?.client_id ?? null,
      clientName: mapping?.client_id ? (clientById.get(mapping.client_id) ?? null) : null,
      excluded: Boolean(mapping?.excluded),
      ambiguous: Boolean(mapping?.ambiguous),
    };
  });

  /*
   * Filtered in JS, not SQL. `tags` is a jsonb array of objects and the filter
   * matches on the NAME inside them, which PostgREST cannot express without a
   * containment operator over the whole object. At ~100 campaigns already
   * fetched, doing it here is free; at ten times that it wants a GIN index and
   * an RPC.
   */
  if (tag) {
    items = items.filter((c) =>
      (Array.isArray(c.tags) ? c.tags : []).some(
        (t: unknown) =>
          typeof t === "object" && t !== null && (t as { name?: string }).name === tag,
      ),
    );
  }

  /*
   * Three kinds of choice, and every campaign belongs to exactly one of them —
   * 152 named + 10 unassigned + 17 excluded = 179, the whole workspace.
   *
   * "excluded" is offered because otherwise those 17 are reachable by NO option:
   * they are deliberately kept out of client reporting (internal tests and the
   * Interested/Not-Interested routing lists), so they carry no client, but
   * "Unassigned" excludes them too. A filter whose options cannot between them
   * reach every row is one that hides work.
   */
  if (clientId) {
    items =
      clientId === "unassigned"
        ? items.filter((c) => !c.clientId && !c.excluded)
        : clientId === "excluded"
          ? items.filter((c) => c.excluded)
          : items.filter((c) => c.clientId === clientId && !c.excluded);
  }

  const statusCounts: Record<string, number> = {};
  for (const row of counts.data ?? []) {
    statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
  }

  return NextResponse.json({
    items,
    total: count ?? items.length,
    statusCounts,
    all: (counts.data ?? []).length,
    clients: (clients.data ?? []).map((c) => ({ id: c.id, name: c.name })),
    tags: [
      ...new Set(
        (allTags.data ?? []).flatMap((row) =>
          (Array.isArray(row.tags) ? row.tags : [])
            .map((t: unknown) =>
              typeof t === "object" && t !== null ? (t as { name?: string }).name : null,
            )
            .filter((n): n is string => Boolean(n)),
        ),
      ),
    ].sort(),
  });
}
