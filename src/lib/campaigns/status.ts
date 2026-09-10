/*
 * Campaign status vocabulary and what you may do to each.
 *
 * ONE authority, imported by the row menu, the bulk bar and the API route. If
 * the button and the server disagreed about whether Resume is offered, the
 * disagreement would be resolved by EmailBison — on real sending.
 */

export const CAMPAIGN_STATUSES = [
  "draft",
  "launching",
  "queued",
  "active",
  "paused",
  "completed",
  "archived",
] as const;

export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/**
 * `queued` is transient and appears in no workspace snapshot, but `resume`
 * returns it — so it must be in the vocabulary or a just-resumed campaign
 * renders as an unknown state.
 */
export function isKnownStatus(value: string): value is CampaignStatus {
  return (CAMPAIGN_STATUSES as readonly string[]).includes(value);
}

/** Tailwind classes per status. Unknown values get a visibly neutral chip. */
export const STATUS_TONE: Record<CampaignStatus, string> = {
  draft: "bg-muted text-muted-foreground",
  launching: "bg-blue-100 text-blue-800",
  queued: "bg-blue-100 text-blue-800",
  active: "bg-emerald-100 text-emerald-800",
  paused: "bg-amber-100 text-amber-900",
  completed: "bg-slate-200 text-slate-700",
  archived: "bg-slate-100 text-slate-500",
};

export const CAMPAIGN_ACTIONS = ["pause", "resume", "archive", "duplicate"] as const;
export type CampaignAction = (typeof CAMPAIGN_ACTIONS)[number];

export function isCampaignAction(value: string): value is CampaignAction {
  return (CAMPAIGN_ACTIONS as readonly string[]).includes(value);
}

/**
 * Whether an action applies to a campaign in this status.
 *
 * The load-bearing rule is `resume`. It is offered ONLY for `paused`, because
 * resume does not restore a previous status — it queues the campaign to send.
 * On a `completed` campaign the word reads as "un-hide this" and the effect is
 * "start emailing everyone still attached to it". Probed and documented in
 * docs/eb-api-findings.md.
 */
/**
 * Which actions exist on each platform, as opposed to which apply to a status.
 *
 * These are DIFFERENT QUESTIONS and conflating them offers buttons that cannot
 * work. `canApply` asks "is this campaign in a state where the action makes
 * sense"; this asks "does the platform have the action at all".
 *
 * Instantly has no archive. Our `archived_at` column is a local concept — it
 * records that a campaign vanished from the API, not something we can ask
 * Instantly to do — so offering Archive there would write a local flag while
 * changing nothing upstream, which is exactly the "shows the change as saved
 * when it wasn't" that spec §9.5 forbids.
 */
export function platformSupports(action: CampaignAction, platform: string): boolean {
  if (platform !== "instantly") return true;
  switch (action) {
    case "pause":
    case "duplicate":
      return true;
    case "resume":
      // /campaigns/{id}/activate — verified on an empty campaign, 0 → 1.
      return true;
    case "archive":
      return false;
  }
}

export function canApply(action: CampaignAction, status: string): boolean {
  switch (action) {
    case "pause":
      // Only states that can still send. Pausing a draft or an archived
      // campaign is a no-op that EmailBison may or may not reject.
      return ["active", "queued", "launching"].includes(status);
    case "resume":
      return status === "paused";
    case "archive":
      return status !== "archived";
    case "duplicate":
      // Copying never sends anything, so it is always available.
      return true;
  }
}

const article = (word: string) => ("aeiou".includes(word[0]) ? "an" : "a");

/** Why an action is unavailable — shown in the disabled menu item's tooltip. */
export function whyNot(action: CampaignAction, status: string): string {
  if (canApply(action, status)) return "";
  if (action === "resume") {
    return status === "completed" || status === "archived"
      ? `Resume queues a campaign to send; it does not reopen ${article(status)} ${status} one`
      : `Only paused campaigns can be resumed (this one is ${status})`;
  }
  if (action === "pause") return `${article(status) === "an" ? "An" : "A"} ${status} campaign is not sending`;
  return `Already ${status}`;
}
