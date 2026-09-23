/*
 * Copy a sequence from one Instantly campaign into another.
 *
 * The two platforms keep sequences in completely different places, which is
 * why this is a separate module rather than a branch inside the EmailBison
 * one. EmailBison exposes steps as their own resource and needs a create,
 * update or delete call per step. Instantly keeps the whole thing in a single
 * `sequences` field on the campaign, so a copy is one read and one PATCH —
 * and, because it is one write, it cannot half-succeed the way a Replace on
 * EmailBison can (that one deletes the old steps before creating the new).
 *
 * INSTANTLY TO INSTANTLY ONLY. The copy is carried across verbatim, and the
 * platforms do not write copy the same way: EmailBison spins `{Hi|Hello}` and
 * merges `{FIRST_NAME}`, Instantly spins `{{RANDOM |Hi|Hello}}` and merges
 * `{{firstName}}`. Moving a body between them unchanged would send a real
 * prospect the literal text `{FIRST_NAME}` and an unspun list of greetings, so
 * a cross-platform copy needs a translation layer and is deliberately not
 * attempted here.
 *
 * No `@/` imports: Node's TS stripping cannot resolve path aliases, and the
 * planning half of this is worth testing directly.
 */

export type CopyMode = "replace" | "append";

export interface InstantlyVariant {
  subject?: string;
  body?: string;
  [key: string]: unknown;
}

export interface InstantlyStep {
  type?: string;
  delay?: number;
  delay_unit?: string;
  variants?: InstantlyVariant[];
  [key: string]: unknown;
}

export interface InstantlySequence {
  steps?: InstantlyStep[];
  [key: string]: unknown;
}

export interface StepSummary {
  order: number;
  subject: string | null;
  waitInDays: number | null;
  variantCount: number;
}

export interface InstantlyCopyPlan {
  sourceId: string;
  sourceName: string;
  targetId: string;
  targetName: string;
  targetStatus: string;
  mode: CopyMode;
  /** What the target's sequence will be afterwards. */
  steps: StepSummary[];
  /** The target's current steps, all of which Replace discards. */
  removing: StepSummary[];
  warnings: string[];
  /** The value to PATCH onto the target. */
  sequences: InstantlySequence[];
}

/** Instantly's numeric status, as the rest of the app spells it. */
export const INSTANTLY_STATUS: Record<number, string> = {
  0: "draft", 1: "active", 2: "paused", 3: "completed", [-1]: "error", [-2]: "suspended",
};

export function stepsOf(sequences: InstantlySequence[] | null | undefined): InstantlyStep[] {
  return sequences?.[0]?.steps ?? [];
}

export function summarise(steps: InstantlyStep[]): StepSummary[] {
  return steps.map((step, i) => ({
    order: i + 1,
    subject: step.variants?.[0]?.subject?.trim() || null,
    waitInDays: typeof step.delay === "number" ? step.delay : null,
    /*
     * A step with no variants array still carries copy in Instantly's UI, so
     * it counts as one rather than zero — reporting 0 variants for a step that
     * sends an email reads as "this step is empty", which it is not.
     */
    variantCount: Math.max(1, step.variants?.length ?? 0),
  }));
}

/**
 * What the target's `sequences` should become, and what that costs.
 *
 * Pure: it takes the two campaigns as already read, so the decision can be
 * shown to a person before anything is written.
 */
export function planInstantlyCopy(input: {
  sourceId: string;
  sourceName: string;
  sourceSequences: InstantlySequence[] | null | undefined;
  targetId: string;
  targetName: string;
  targetStatus: number | null | undefined;
  targetSequences: InstantlySequence[] | null | undefined;
  mode: CopyMode;
}): InstantlyCopyPlan {
  const { mode } = input;
  const sourceSteps = stepsOf(input.sourceSequences);
  const targetSteps = stepsOf(input.targetSequences);
  const warnings: string[] = [];

  if (input.sourceId === input.targetId) {
    warnings.push("A campaign cannot copy its sequence into itself.");
  }
  if (sourceSteps.length === 0) {
    warnings.push(`"${input.sourceName}" has no sequence steps to copy.`);
  }

  const status = INSTANTLY_STATUS[input.targetStatus ?? 0] ?? "unknown";
  if (status === "active") {
    warnings.push(
      `"${input.targetName}" is active — it is sending. Its next emails will use the new sequence.`,
    );
  }

  /*
   * Deep-cloned so the plan owns its data: the caller holds the source
   * campaign it was read from, and a PATCH body that shares objects with it is
   * one careless mutation away from editing the source instead.
   */
  const copied: InstantlyStep[] = structuredClone(sourceSteps);
  const finalSteps = mode === "replace" ? copied : [...structuredClone(targetSteps), ...copied];

  /*
   * Everything except `steps` is preserved from whichever sequence object is
   * being kept, so any field Instantly adds later survives a copy instead of
   * being silently dropped.
   */
  const base = (mode === "replace" ? input.sourceSequences?.[0] : input.targetSequences?.[0]) ?? {};
  const sequences: InstantlySequence[] = [{ ...structuredClone(base), steps: finalSteps }];

  return {
    sourceId: input.sourceId,
    sourceName: input.sourceName,
    targetId: input.targetId,
    targetName: input.targetName,
    targetStatus: status,
    mode,
    steps: summarise(finalSteps),
    removing: mode === "replace" ? summarise(targetSteps) : [],
    warnings,
    sequences,
  };
}
