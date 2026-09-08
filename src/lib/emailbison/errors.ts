
/*
 * The API error type lives here rather than in client.ts for two reasons: it
 * breaks the cycle that would otherwise exist (client imports assertApplied,
 * errors imports the class), and it keeps this module importable by a test
 * without dragging in fetch.
 *
 * Written with explicit fields rather than TypeScript parameter properties.
 * Parameter properties are the one common TS feature Node's strip-only mode
 * cannot handle — it is a transform, not an erasure — and this repo runs its
 * tests directly against .ts with no build step. The old form made every module
 * in this directory untestable.
 */
export class EmailBisonApiError extends Error {
  readonly statusCode: number;
  readonly response?: unknown;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    statusCode: number,
    response?: unknown,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "EmailBisonApiError";
    this.statusCode = statusCode;
    this.response = response;
    this.retryAfterMs = retryAfterMs;
  }
}

/*
 * Turning an EmailBison failure into the sentence a human should read.
 *
 * Spec §9.5: "If a change can't be applied on the sending platform, the
 * dashboard says so with the ACTUAL REASON." A message of "EmailBison 422
 * Unprocessable Content" satisfies the letter of that and none of its purpose —
 * the operator still has no idea what to change.
 *
 * The shape that matters, observed on PATCH /api/campaigns/{id}/update:
 *
 *   {"data": {"success": false,
 *             "message": "The max emails per day field must be greater than or
 *                         equal to max new leads per day.",
 *             "errors": {"max_emails_per_day": ["..."]}}}
 *
 * Note the nesting under `data`. EmailBison wraps errors the same way it wraps
 * resources, so anything that only reads the top level finds nothing and falls
 * back to the status line.
 */

/** Unwraps EmailBison's `{data: ...}` envelope, which errors use too. */
function unwrap(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const inner = record.data;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    return inner as Record<string, unknown>;
  }
  return record;
}

/** The platform's own words, or the status line if it offered none. */
export function describeEmailBisonError(error: unknown): string {
  if (!(error instanceof EmailBisonApiError)) {
    return error instanceof Error ? error.message : String(error);
  }

  const body = unwrap(error.response);
  if (body) {
    if (typeof body.message === "string" && body.message) return body.message;

    // Laravel-style validation: {errors: {field: ["reason", ...]}}. Every
    // reason is joined rather than just the first, because a rejected form
    // usually has more than one thing wrong with it.
    if (body.errors && typeof body.errors === "object") {
      const reasons = Object.values(body.errors as Record<string, unknown>)
        .flatMap((v) => (Array.isArray(v) ? v : [v]))
        .filter((v): v is string => typeof v === "string");
      if (reasons.length) return reasons.join(" ");
    }
  }

  return error.message;
}

/**
 * Some EmailBison writes answer 2xx with `success: false` in the body.
 *
 * Trusting the status alone would report those as applied — the exact failure
 * §9.5 forbids, and the hardest kind to notice because the UI looks correct and
 * the sending platform simply never changed.
 */
export function assertApplied(payload: unknown, endpoint: string): void {
  const body = unwrap(payload);
  if (body && body.success === false) {
    throw new EmailBisonApiError(
      typeof body.message === "string" && body.message
        ? body.message
        : `EmailBison refused the change on ${endpoint}`,
      200,
      payload,
    );
  }
}

/**
 * The array indices EmailBison rejected in a `lead_ids` (or similar) payload.
 *
 * DELETE /api/campaigns/{id}/leads is ALL-OR-NOTHING: if any id in the batch is
 * not currently attached to that campaign, the whole request is refused with
 *
 *   {"errors": {"lead_ids.2": ["The selected lead_ids.2 is invalid."]}}
 *
 * and nothing is removed. That matters because a selection made on screen goes
 * stale — a lead removed in EmailBison, or by someone else, five minutes ago is
 * enough to make a 500-id chunk fail entirely.
 *
 * The key names the ZERO-BASED INDEX into the array we sent, so the offending
 * ids can be dropped precisely and the rest retried, rather than failing the
 * batch or blindly retrying one id at a time.
 *
 * Returns indices, not ids, because that is what the API actually tells us;
 * mapping back to ids is the caller's job and depends on the array it sent.
 */
export function invalidIndices(error: unknown, field: string): number[] {
  if (!(error instanceof EmailBisonApiError)) return [];
  const body = unwrap(error.response);
  const errors = body?.errors;
  if (!errors || typeof errors !== "object") return [];

  const out = new Set<number>();
  for (const key of Object.keys(errors as Record<string, unknown>)) {
    // `lead_ids.2` → 2. Anchored so `other_ids.2` cannot match.
    const match = new RegExp(`^${field}\\.(\\d+)$`).exec(key);
    if (match) out.add(Number(match[1]));
  }
  return [...out].sort((a, b) => a - b);
}
