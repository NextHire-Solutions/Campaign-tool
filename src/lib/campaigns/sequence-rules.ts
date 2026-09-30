/*
 * Delete / turn off a sequence step (1 Oct) — the rules, pure and tested.
 * Verified on draft test campaigns in both platforms before being written:
 *
 * EmailBison
 *   · deletes a step that has never sent; refuses one that has (existing
 *     finding) and refuses to remove a campaign's LAST step;
 *   · turns a step or variant on/off ONLY while the campaign is paused
 *     ("The campaign needs to be paused before you can activate/deactivate a
 *     variant") — main steps and variants alike.
 * Instantly
 *   · the sequence is edited whole (PATCH sequences): a step or variant can be
 *     removed and a variant switched off (`v_disabled`) in any state.
 *
 * User decision (1 Oct): Delete what has never sent; Turn off / Turn on what
 * has. A main step with variants is deleted only once its variants are gone,
 * so a delete never takes more than the one row the person clicked.
 */

export interface RuleStep {
  key: string;
  isVariant: boolean;
  parentKey: string | null;
  /** Emails sent from this step or variant; null when unknown. */
  sent: number | null;
  active: boolean;
}

export interface StepPermission {
  canDelete: boolean;
  deleteWhy: string | null;
  canToggle: boolean;
  toggleWhy: string | null;
}

export function stepPermissions(
  platform: "emailbison" | "instantly",
  campaignStatus: string,
  steps: RuleStep[],
  key: string,
): StepPermission {
  const step = steps.find((s) => s.key === key);
  if (!step) return { canDelete: false, deleteWhy: "This step is no longer in the campaign.", canToggle: false, toggleWhy: "This step is no longer in the campaign." };
  const mains = steps.filter((s) => !s.isVariant);
  const children = steps.filter((s) => s.parentKey === step.key);
  const draft = campaignStatus === "draft";
  const sentKnown = step.sent !== null;
  const unsent = sentKnown ? step.sent === 0 : draft;

  let deleteWhy: string | null = null;
  if (!unsent) deleteWhy = sentKnown ? "It has sent emails — turn it off instead." : "Its sends could not be read, so it is only deletable on a draft.";
  else if (!step.isVariant && children.length) deleteWhy = "Delete its variants first.";
  else if (!step.isVariant && mains.length <= 1) deleteWhy = "A campaign needs at least one step.";

  let toggleWhy: string | null = null;
  if (unsent) toggleWhy = "It has not sent — delete it instead.";
  else if (platform === "emailbison" && campaignStatus !== "paused") toggleWhy = "Pause the campaign first — EmailBison only turns steps on or off while a campaign is paused.";
  else if (platform === "instantly" && !step.isVariant && children.length === 0 && step.active) toggleWhy = "This is the step's only version; turning it off would leave the step empty.";

  return { canDelete: deleteWhy === null, deleteWhy, canToggle: toggleWhy === null, toggleWhy };
}
