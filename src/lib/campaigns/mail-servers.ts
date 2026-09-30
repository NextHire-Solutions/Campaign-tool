/*
 * "Remove Unsupported Mail Servers" (1 Oct) — which leads count as unsupported.
 *
 * Verified against both platforms on a draft test campaign with one lead per
 * server, before this was built:
 *
 *   EmailBison tags every lead with its mail server the moment it is added
 *   (Google, Outlook, Zoho, Custom Mail Server, Proofpoint, Mimecast,
 *   Barracuda, Sophos, Outlook Gov). The five unsupported ones are removed;
 *   Sophos and Outlook Gov stay (user decision, 1 Oct).
 *
 *   Instantly reports an `esp_code`: 1 Google, 2 Microsoft, 3 Zoho, and 999
 *   for everything else — custom servers AND Proofpoint, Mimecast and
 *   Barracuda came back identical (999). Instantly cannot tell them apart, so
 *   3 and 999 are removed; 0 means "not detected yet" and is left alone.
 */

export const UNSUPPORTED_EMAILBISON_TAGS = ["Proofpoint", "Mimecast", "Barracuda", "Zoho", "Custom Mail Server"] as const;

export const UNSUPPORTED_INSTANTLY_ESP: Record<number, string> = {
  3: "Zoho",
  999: "Custom / security gateway (Proofpoint, Mimecast, Barracuda…)",
};

export function isUnsupportedInstantly(espCode: number | null | undefined): boolean {
  return espCode != null && espCode in UNSUPPORTED_INSTANTLY_ESP;
}

/** Tag name → id for the unsupported tags that exist in the workspace. Missing ones are reported, not guessed. */
export function unsupportedTagIds(tags: { id: number; name: string }[]): { found: { id: number; name: string }[]; missing: string[] } {
  const found: { id: number; name: string }[] = [];
  const missing: string[] = [];
  for (const name of UNSUPPORTED_EMAILBISON_TAGS) {
    const t = tags.find((x) => x.name.trim().toLowerCase() === name.toLowerCase());
    if (t) found.push({ id: t.id, name }); else missing.push(name);
  }
  return { found, missing };
}
