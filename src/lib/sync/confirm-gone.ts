/*
 * Is a shortfall a real deletion, or a bad response?
 *
 * The archive guard used to answer that with arithmetic alone: a walk
 * returning less than half of what we hold was assumed truncated, and nothing
 * was archived. That is the right instinct and it saved the estate more than
 * once — but it cannot tell the two cases apart, so it also refuses forever
 * when a deletion really is that large.
 *
 * It happened: a client deleted all 318 Instantly campaigns at once. The walk
 * returned 0, the guard declined, and it logged
 *
 *   declined to archive 318: walk returned 0 against 318 live — looks truncated
 *
 * every hour for seventeen hours while the dashboard showed 318 campaigns that
 * no longer existed.
 *
 * So ask the API instead of guessing. Probe a sample of the rows that went
 * missing, one by one:
 *
 *   every probe says 404  -> they are really gone. Archive.
 *   any probe returns one -> the walk was truncated. Decline, as before.
 *   any probe fails oddly -> we do not know. Decline; the job re-runs hourly.
 *
 * Declining still costs an hour. Archiving wrongly costs the Infrastructure
 * tab, so anything short of unanimous agreement stays a decline.
 */

export type GoneVerdict =
  | { archive: true; reason: string }
  | { archive: false; reason: string };

export interface ConfirmOptions {
  /** Override the sample size. Normally left to scale with the loss. */
  sample?: number;
  /** Fetch one by id. Must throw an error carrying `status` when absent. */
  fetchOne: (id: string) => Promise<unknown>;
}

/** Spread the sample across the list rather than taking the first n. */
export function spread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return [...items];
  const step = items.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.floor(i * step)]);
  return out;
}

/*
 * How many to probe. A fixed handful is fine for an all-or-nothing loss, but
 * the dangerous case is a MIXED one: some rows really deleted, others missing
 * because the walk was cut short. Sample too few and the probes can all land
 * on genuinely-deleted ids while the truncated ones are archived with them.
 * So the sample grows with the loss — 5% of it, never fewer than 8, capped at
 * 25 so a huge deletion still costs a handful of calls rather than hundreds.
 */
export function sampleSize(missing: number): number {
  return Math.min(25, Math.max(8, Math.ceil(missing * 0.05)));
}

export async function confirmGone(
  missing: string[],
  { sample, fetchOne }: ConfirmOptions,
): Promise<GoneVerdict> {
  if (missing.length === 0) return { archive: false, reason: "nothing missing" };

  const probes = spread(missing, sample ?? sampleSize(missing.length));
  let gone = 0;
  for (const id of probes) {
    try {
      await fetchOne(id);
      return {
        archive: false,
        reason: `${id} still resolves — the walk was truncated, not a deletion`,
      };
    } catch (error) {
      /*
       * Duck-typed on purpose: this stays free of any API client so it can be
       * reused by the EmailBison and sender syncs, whose errors carry the same
       * field under a different class.
       */
      const e = error as { statusCode?: number; status?: number } | null;
      const status = e?.statusCode ?? e?.status;
      if (status === 404) {
        gone++;
        continue;
      }
      return {
        archive: false,
        reason: `probe of ${id} failed with ${status ?? "no status"} — cannot tell deleted from unreachable`,
      };
    }
  }

  return {
    archive: true,
    reason: `${gone}/${probes.length} sampled ids return 404 — confirmed deleted`,
  };
}
