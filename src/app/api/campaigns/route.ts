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
  /*
   * Platform, empty meaning BOTH — unlike the analytics bar, where an empty
   * platform filter means EmailBison only because Positive cannot cover
   * Instantly. There is no such metric here: this is a list of campaigns, and a
   * list that silently omits 318 of 501 is the bug this replaced.
   */
  const platforms = (params.get("platforms") ?? "")
    .split(",").map((p) => p.trim()).filter(Boolean);
  const search = (params.get("q") ?? "").trim();
  const clientId = params.get("client_id");
  const tag = params.get("tag");
  const limit = Math.min(Number(params.get("limit") ?? 200), 500);
  const offset = Math.max(Number(params.get("offset") ?? 0), 0);

  let query = sb
    .from("campaigns_unified")
    .select(
      "id, platform, name, status, tags, total_leads, lifetime_emails_sent, lifetime_unique_replies, completion_percentage, max_emails_per_day, created_at, updated_at, client_id, excluded, ambiguous",
      /*
       * EXACT, not estimated. `estimated` reads the planner's row estimate,
       * which ignores the filters entirely on a small table — that is how the
       * header came to read 184 above three rows. At this size the count costs
       * nothing; rule 7's warning is about `replies`, which is 100× larger.
       */
      { count: "exact" },
    )
    // The view already excludes campaigns deleted or archived upstream.
    .eq("team_id", teamId);

  if (platforms.length === 1) query = query.eq("platform", platforms[0]);

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
    /*
     * Both mapping tables, because the list now spans both platforms and the
     * ids do not collide (bigint vs uuid) once cast to text. Reading only the
     * EmailBison table would silently drop every Instantly campaign from a
     * client filter while appearing to consider them.
     */
    const [ebMaps, instMaps] = await Promise.all([
      sb.from("campaign_clients").select("campaign_id, client_id, excluded"),
      sb.from("instantly_campaign_clients").select("campaign_id, client_id, excluded"),
    ]);
    const rowsOf = [...(ebMaps.data ?? []), ...(instMaps.data ?? [])].map((m) => ({
      campaign_id: String((m as { campaign_id: unknown }).campaign_id),
      client_id: (m as { client_id: string | null }).client_id,
      excluded: Boolean((m as { excluded: boolean }).excluded),
    }));

    if (clientId === "unassigned") {
      /*
       * "No client AND not excluded" — so the complement must remove BOTH the
       * assigned and the excluded, not just the assigned. Removing only the
       * assigned left the excluded campaigns in, making "Unassigned" and
       * "Excluded" return the same rows and the three options stop partitioning
       * the workspace.
       *
       * Ids are QUOTED because they are text now and a uuid contains hyphens,
       * which PostgREST would otherwise read as part of its list syntax.
       */
      const spokenFor = rowsOf
        .filter((m) => m.excluded || m.client_id !== null)
        .map((m) => `"${m.campaign_id}"`);
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
       * the one case PostgREST turns into a no-op, so it is spelled out — the
       * same "no restriction vs no rows" trap that let the campaign filter leak
       * an entire platform into the analytics totals.
       */
      query = wanted.length ? query.in("id", wanted) : query.eq("id", "__none__");
    }
  }

  const [{ data: rows, error, count }, clients, counts, allTags] = await Promise.all([
    query.order("lifetime_emails_sent", { ascending: false, nullsFirst: false })
      .range(offset, offset + limit - 1),
    sb.from("clients").select("id, name").eq("team_id", teamId),
    // One grouped read for the status pills, so their numbers describe the
    // whole workspace rather than the current page. Now across both platforms.
    sb.from("campaigns_unified").select("status, platform").eq("team_id", teamId),
    // Tags for the filter's own dropdown, read from the data rather than a
    // hardcoded list. EmailBison only — Instantly's tags live in a separate
    // custom-tags resource that is not synced, and the view says so with an
    // empty array rather than inventing them.
    sb.from("campaigns").select("tags").eq("team_id", teamId).is("deleted_at", null),
  ]);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const clientById = new Map((clients.data ?? []).map((c) => [c.id, c.name]));

  // The view already carries the mapping, so there is no second lookup to drift
  // out of step with it.
  const items = (rows ?? []).map((c) => ({
    ...c,
    clientId: c.client_id ?? null,
    clientName: c.client_id ? (clientById.get(c.client_id) ?? null) : null,
    excluded: Boolean(c.excluded),
    ambiguous: Boolean(c.ambiguous),
    eb_updated_at: c.updated_at ?? null,
  }));

  const statusCounts: Record<string, number> = {};
  const platformCounts: Record<string, number> = {};
  for (const row of counts.data ?? []) {
    // The pills must describe the same scope the list is showing, so a platform
    // filter narrows them too — otherwise "Active 40" sits above 12 rows.
    if (platforms.length === 1 && row.platform !== platforms[0]) continue;
    statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
    platformCounts[row.platform] = (platformCounts[row.platform] ?? 0) + 1;
  }

  return NextResponse.json({
    items,
    total: count ?? items.length,
    statusCounts,
    platformCounts,
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
