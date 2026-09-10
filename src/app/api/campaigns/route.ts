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
      /*
       * EXACT, not estimated. `estimated` reads the planner's row estimate,
       * which ignores the filters entirely on a small table — that is how the
       * header came to read 184 above three rows. At this size the count costs
       * nothing; rule 7's warning is about `replies`, which is 100× larger.
       */
      { count: "exact" },
    )
    .eq("team_id", teamId)
    // Deleted upstream: kept for history, never offered as a choice.
    .is("deleted_at", null);

  if (status !== "all") query = query.eq("status", status);
  // `ilike` with a leading wildcard can't use a btree index, but at 95 rows
  // that is irrelevant; revisit with a trigram index if this grows.
  if (search) query = query.ilike("name", `%${search}%`);

  /*
   * CLIENT AND TAG ARE FILTERED IN SQL, BEFORE PAGING. They used to be applied
   * in JS to the already-paged rows, which broke both halves of the answer:
   *
   *   - `total` came from the SQL count, which knew nothing about the JS
   *     filtering. The page rendered "184" above a list of 3. That number is
   *     the header count AND the pagination basis, so it was wrong twice.
   *   - The filter only ever saw the current page. It happens to be correct
   *     today because the default page (200) is larger than the workspace
   *     (184); it would start silently dropping matches the moment that stops
   *     being true, with no error and no visible symptom.
   *
   * `tags` is a jsonb array of tag OBJECTS, so the match is containment of
   * `[{"name": …}]` rather than equality — verified to select the same 3
   * campaigns the JS predicate did.
   */
  /*
   * `.contains()` serialises to a POSTGRES ARRAY literal — `{...}` — which a
   * jsonb column rejects with "invalid input syntax for type json". The raw
   * `cs` filter with a JSON string is the form jsonb containment needs.
   */
  if (tag) query = query.filter("tags", "cs", JSON.stringify([{ name: tag }]));

  if (clientId) {
    /*
     * Three kinds of choice, and every campaign belongs to exactly one:
     * a named client, "unassigned", or "excluded". The excluded ones are
     * offered deliberately — they are kept out of client reporting (internal
     * tests and the Interested/Not-Interested routing lists) so they carry no
     * client, and "Unassigned" excludes them too. A filter whose options
     * cannot between them reach every row is one that hides work.
     */
    // campaign_clients has no team_id — it is keyed by campaign_id alone, and
    // scoping it to a team here returned nothing, which turned "unassigned"
    // into "everything".
    const { data: maps } = await sb
      .from("campaign_clients")
      .select("campaign_id, client_id, excluded");
    const rowsOf = (maps ?? []) as Array<{
      campaign_id: number;
      client_id: string | null;
      excluded: boolean;
    }>;

    if (clientId === "unassigned") {
      /*
       * "No client AND not excluded" — so the complement must remove BOTH the
       * assigned and the excluded, not just the assigned. Removing only the
       * assigned left the 20 excluded campaigns in, making "Unassigned" and
       * "Excluded" return the same 20 rows and the three options stop
       * partitioning the workspace.
       *
       * Verified against SQL: 157 assigned + 7 unassigned + 20 excluded = 184.
       */
      const spokenFor = rowsOf
        .filter((m) => m.excluded || m.client_id !== null)
        .map((m) => m.campaign_id);
      if (spokenFor.length) query = query.not("id", "in", `(${spokenFor.join(",")})`);
    } else {
      const wanted = rowsOf
        .filter((m) =>
          clientId === "excluded"
            ? m.excluded
            : m.client_id === clientId && !m.excluded,
        )
        .map((m) => m.campaign_id);
      /*
       * An empty match must return nothing, not everything. `.in("id", [])` is
       * the one case PostgREST turns into a no-op, so it is spelled out — this
       * is the same "null means no restriction" trap that let the campaign
       * filter leak an entire platform into the totals.
       */
      query = wanted.length ? query.in("id", wanted) : query.eq("id", -1);
    }
  }

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

  const items = (rows ?? []).map((c) => {
    const mapping = mapByCampaign.get(c.id);
    return {
      ...c,
      clientId: mapping?.client_id ?? null,
      clientName: mapping?.client_id ? (clientById.get(mapping.client_id) ?? null) : null,
      excluded: Boolean(mapping?.excluded),
      ambiguous: Boolean(mapping?.ambiguous),
    };
  });

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
