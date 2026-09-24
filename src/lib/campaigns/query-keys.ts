/*
 * The React Query key for one campaign's detail query.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A FUNCTION AND NOT AN INLINE ARRAY
 *
 * React Query compares keys STRUCTURALLY, so `["campaign", 276]` and
 * `["campaign", "276"]` are two different queries. The detail page receives its
 * id as a route string and registers under `["campaign", "276"]`, but a
 * campaign row carries `id` as it comes out of the database — a bigint for
 * EmailBison, a uuid for Instantly.
 *
 * So any call site holding the ROW rather than the route param invalidated
 * `["campaign", 276]`, which matched nothing. The refetch never happened, the
 * component kept its pre-save props, and the Settings tab went on showing
 * "Unsaved changes" after a save that had in fact succeeded — reported as "the
 * save button is not working" when the save was fine and only the screen was
 * stale. Three of the six call sites had it wrong, and the two id spaces are
 * why it looked intermittent: an Instantly uuid is already a string and
 * matched by luck, so the bug only ever showed on EmailBison campaigns.
 *
 * One builder, used by every site, normalises to the string form the query is
 * actually registered under. There is no longer a way to pass the wrong type:
 * a number and a string produce the same key.
 *
 * No `@/` imports — Node's native TS stripping cannot resolve path aliases and
 * this needs to be directly testable.
 */

export function campaignKey(id: string | number): readonly ["campaign", string] {
  return ["campaign", String(id)];
}
