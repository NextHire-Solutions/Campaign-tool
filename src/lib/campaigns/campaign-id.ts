/*
 * Which platform a campaign id belongs to, from its shape.
 *
 * Normally a bare id is ambiguous and `platform` has to travel with it — that
 * is why the bulk-action and inbox routes take `{platform, id}` pairs. On a
 * route whose PATH is the id (`/api/campaigns/[id]/leads`) there is no pair to
 * pass, and shape is genuinely sufficient: EmailBison keys with a bigint and
 * Instantly with a uuid, so the two spaces cannot collide. A uuid is never a
 * valid EmailBison id and a plain integer is never a valid Instantly one.
 *
 * Anything else returns null rather than a guess. A malformed id should 404,
 * not be silently routed at one platform and reported as "not found" there.
 *
 * No `@/` imports: Node's native TS stripping cannot resolve path aliases, and
 * this needs to be directly testable.
 */

export type CampaignPlatform = "emailbison" | "instantly";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POSITIVE_INT = /^[1-9]\d*$/;

export function platformOfId(id: string): CampaignPlatform | null {
  const value = id.trim();
  if (UUID.test(value)) return "instantly";
  if (POSITIVE_INT.test(value)) return "emailbison";
  return null;
}
