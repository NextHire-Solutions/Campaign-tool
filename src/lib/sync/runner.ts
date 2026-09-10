import { getSupabase } from "@/lib/supabase/server";

/*
 * Cron bookkeeping: locking, run history, and a circuit breaker.
 *
 * Three properties every job gets for free:
 *
 *  1. NO OVERLAP. `sync_state.running_since` is a lock. A job already running
 *     is skipped rather than run twice — two concurrent day-stat syncs would
 *     double the EmailBison call volume for identical results.
 *
 *  2. CRASH RECOVERY. A lock older than the stale threshold is stolen. Without
 *     that, one crashed run would wedge the job permanently, and the failure
 *     mode ("data silently stopped updating") is the hardest kind to notice.
 *
 *  3. CIRCUIT BREAKER. After MAX_FAILURES consecutive failures the job stops
 *     attempting. If EmailBison is down or the key is revoked, hammering it
 *     every 10 minutes helps nobody; `last_error` is left in place to explain.
 */

/*
 * How long a lock is honoured before it's assumed to belong to a dead process.
 *
 * Every redeploy kills whatever was mid-sweep, so this is not an edge case —
 * it happens on every deploy, and it is the only thing standing between a
 * killed run and a job that never runs again.
 *
 * Ten minutes is calibrated against what these jobs actually take. Measured in
 * production: entities 9s, steps 13s, daily-series 14s (deep 31s), replies 16s
 * (deep 60s), day-stats 26s (deep 102s), reply-timing 122-212s. The slowest is
 * under four minutes, so ten is a wide margin.
 *
 * Getting it too short costs a duplicate run — extra EmailBison calls, and
 * nothing else, because every job is idempotent. Getting it too long means a
 * dead job stays dead: at the old 30 minutes, a deploy landing mid-sweep cost
 * the 10-minute reply sync three consecutive ticks.
 *
 * Releasing locks on SIGTERM would be better than any timeout, but Next
 * installs its own signal handler that calls process.exit(0), and its
 * cleanup-listener hook is dev-only — an async release can't reliably finish.
 */
const STALE_LOCK_MS = 10 * 60 * 1000;
const MAX_FAILURES = 5;

export interface JobResult {
  rowsWritten?: number;
  apiCalls?: number;
  /**
   * New watermark, persisted ONLY on success. A job that fails keeps the old
   * one and re-covers the same window next time — the property that makes a
   * missed run a non-event.
   */
  watermark?: string;
  detail?: Record<string, unknown>;
}

export type JobFn = (ctx: {
  teamId: number;
  /** Persisted cursor from the last successful run, if the job uses one. */
  cursorDate: string | null;
  /**
   * An opaque string cursor, for endpoints whose pagination token is neither a
   * date nor an id — Instantly's `starting_after` is uuid-shaped.
   */
  cursorText: string | null;
  watermark: string | null;
}) => Promise<JobResult>;

export interface RunOutcome {
  job: string;
  status: "ok" | "error" | "skipped" | "circuit-open";
  durationMs: number;
  rowsWritten?: number;
  apiCalls?: number;
  error?: string;
  detail?: Record<string, unknown>;
}

export async function runJob(
  jobName: string,
  teamId: number,
  fn: JobFn,
): Promise<RunOutcome> {
  const sb = getSupabase();
  const startedAt = Date.now();

  const { data: state } = await sb
    .from("sync_state")
    .select("running_since, consecutive_failures, cursor_date, cursor_text, watermark_at")
    .eq("job_name", jobName)
    .eq("team_id", teamId)
    .maybeSingle();

  if (state?.running_since) {
    const age = Date.now() - new Date(state.running_since).getTime();
    if (age < STALE_LOCK_MS) {
      return { job: jobName, status: "skipped", durationMs: 0, error: "already running" };
    }
    console.warn(`[cron] ${jobName}: stealing a stale lock (${Math.round(age / 1000)}s old)`);

    /*
     * Reap the run the dead process left open.
     *
     * A container replaced mid-sweep — which is what every redeploy does —
     * leaves a `sync_runs` row with a NULL finished_at that nothing else ever
     * closes. Left alone the history reads as "that job is still running",
     * indefinitely, which is precisely the state you'd be looking at the
     * history to rule out.
     */
    await sb
      .from("sync_runs")
      .update({
        finished_at: new Date().toISOString(),
        status: "abandoned",
        error: "process exited mid-run (lock stolen after staleness timeout)",
      })
      .eq("job_name", jobName)
      .eq("team_id", teamId)
      .is("finished_at", null);
  }

  if ((state?.consecutive_failures ?? 0) >= MAX_FAILURES) {
    return {
      job: jobName,
      status: "circuit-open",
      durationMs: 0,
      error: `${state!.consecutive_failures} consecutive failures — reset sync_state to retry`,
    };
  }

  await sb.from("sync_state").upsert(
    {
      job_name: jobName,
      team_id: teamId,
      running_since: new Date().toISOString(),
      last_run_at: new Date().toISOString(),
    },
    { onConflict: "job_name,team_id" },
  );

  const { data: run } = await sb
    .from("sync_runs")
    .insert({ job_name: jobName, team_id: teamId })
    .select("id")
    .single();

  try {
    const result = await fn({
      teamId,
      cursorDate: state?.cursor_date ?? null,
      cursorText: state?.cursor_text ?? null,
      watermark: state?.watermark_at ?? null,
    });
    const durationMs = Date.now() - startedAt;

    await Promise.all([
      sb.from("sync_state").update({
        running_since: null,
        last_success_at: new Date().toISOString(),
        consecutive_failures: 0,
        last_error: null,
        ...(result.watermark ? { watermark_at: result.watermark } : {}),
      }).eq("job_name", jobName).eq("team_id", teamId),
      run?.id
        ? sb.from("sync_runs").update({
            finished_at: new Date().toISOString(),
            status: "ok",
            rows_written: result.rowsWritten ?? null,
            api_calls: result.apiCalls ?? null,
          }).eq("id", run.id)
        : Promise.resolve(),
    ]);

    return { job: jobName, status: "ok", durationMs, ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[cron] ${jobName} failed:`, message);

    await Promise.all([
      // Read-modify-write is safe here specifically BECAUSE of the lock above:
      // only one run of a job is ever in this path at a time.
      sb.from("sync_state").update({
        running_since: null,
        last_error: message,
        consecutive_failures: (state?.consecutive_failures ?? 0) + 1,
      }).eq("job_name", jobName).eq("team_id", teamId),
      run?.id
        ? sb.from("sync_runs").update({
            finished_at: new Date().toISOString(),
            status: "error",
            error: message,
          }).eq("id", run.id)
        : Promise.resolve(),
    ]);

    return {
      job: jobName,
      status: "error",
      durationMs: Date.now() - startedAt,
      error: message,
    };
  }
}

/** Records an opaque page cursor, so the next run resumes mid-walk. */
export async function setCursorText(
  jobName: string,
  teamId: number,
  cursorText: string | null,
): Promise<void> {
  await getSupabase()
    .from("sync_state")
    .update({ cursor_text: cursorText })
    .eq("job_name", jobName)
    .eq("team_id", teamId);
}

/** Records the cursor a date-driven job reached, so the next run resumes there. */
export async function setCursor(
  jobName: string,
  teamId: number,
  cursorDate: string,
): Promise<void> {
  await getSupabase()
    .from("sync_state")
    .update({ cursor_date: cursorDate })
    .eq("job_name", jobName)
    .eq("team_id", teamId);
}
