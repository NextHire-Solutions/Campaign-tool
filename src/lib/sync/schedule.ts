import type { JOBS } from "./jobs";

/*
 * The cron cadence, as data.
 *
 * Cadence follows how fast each source actually changes, not how cheap it is:
 *
 *   replies       10 min  — the only metric anyone watches for during a day
 *   entities      30 min  — new campaigns and the client mapping
 *   daily series   1 h    — one call per campaign returns the WHOLE window, so
 *                           a 7-day sweep costs the same as a 1-day one
 *   reply timing   1 h    — a draining work queue, capped at 500 replies/run
 *   day stats      3 h    — 95 campaigns x 3 days = ~285 calls; the expensive one
 *
 * The nightly sweeps are drift repair: EmailBison revises recent days after the
 * fact (late bounces, delayed opens, `interested` flipped by hand), so a wide
 * re-fetch each night is what keeps last month's numbers from slowly diverging
 * from the source. They are staggered an hour apart so they never contend for
 * the same rate-limit budget.
 *
 * All times are UTC. 06:00–09:00 UTC is 02:00–05:00 in the workspace's
 * America/New_York timezone, i.e. the quietest sending window.
 */

/** Every job the registry actually implements. */
export type JobName = keyof typeof JOBS;

export interface ScheduleEntry {
  readonly job: JobName;
  /** Fires whenever minute-of-day is divisible by this. */
  readonly everyMinutes?: number;
  /** Fires once a day, at :00 of this UTC hour. */
  readonly dailyAtUtcHour?: number;
}

/*
 * `satisfies` rather than a type annotation, so the literal job names survive
 * for the exhaustiveness check below. `import type` above means this module
 * never loads jobs.ts at runtime — the link is purely a compile-time one.
 */
export const SCHEDULE = [
  { job: "sync-replies", everyMinutes: 10 },
  { job: "sync-entities", everyMinutes: 30 },
  { job: "sync-daily-series", everyMinutes: 60 },
  { job: "sync-reply-timing", everyMinutes: 60 },
  { job: "sync-day-stats", everyMinutes: 180 },
  // ~98 calls; the Infrastructure tab's only source. Inbox health changes on
  // the scale of hours, not minutes.
  { job: "sync-senders", everyMinutes: 180 },
  // The outcomes feed changes on human timescales, not sending timescales.
  { job: "sync-outcomes", everyMinutes: 60 },
  // A draining queue: 400 addresses a run, ~1 EmailBison call each.
  { job: "sync-outcome-attribution", everyMinutes: 60 },
  // ~350 calls to walk the lead list. Replier attributes change on the scale
  // of job moves, not sends, so nightly is generous.
  { job: "sync-leads", dailyAtUtcHour: 5 },
  { job: "sync-steps", dailyAtUtcHour: 6 },
  { job: "sync-daily-series-deep", dailyAtUtcHour: 7 },
  { job: "sync-day-stats-deep", dailyAtUtcHour: 8 },
  { job: "sync-replies-deep", dailyAtUtcHour: 9 },
  // 41 pages for a full walk, one or two incrementally — cheap enough to run
  // often, and Positive is the number people watch during a working day.
  { job: "sync-reply-labels", everyMinutes: 30 },
  { job: "sync-reply-labels-deep", dailyAtUtcHour: 10 },
  // ~420 pages per day of window. The frequent one keeps membership current;
  // the nightly deep re-reads a week so late opens and clicks land.
  // A draining queue over DNS. Hourly while it has work, then a no-op.
  { job: "sync-esp-domains", everyMinutes: 60 },
  { job: "sync-campaign-leads", everyMinutes: 180 },
  { job: "sync-campaign-leads-deep", dailyAtUtcHour: 11 },

  /*
   * Instantly. Its own tables, its own cadences, and one limit that dictates
   * all of them: /emails allows 20 requests a minute where every other
   * Instantly endpoint gets 6,000.
   *
   * Campaigns and accounts are almost free — Instantly returns EVERY
   * campaign's metrics in a single call, so the whole campaign sync is about
   * five requests against EmailBison's ninety-odd.
   */
  { job: "sync-instantly-campaigns", everyMinutes: 60 },
  { job: "sync-instantly-accounts", everyMinutes: 180 },
  // Pools change rarely; 3 hours is plenty and keeps this off the busy minutes.
  { job: "sync-instantly-account-tags", everyMinutes: 180 },
  // Costs nothing upstream — it only re-reads names we already hold.
  { job: "sync-instantly-clients", everyMinutes: 60 },
  // Asks which campaigns were active in the window first, so it makes one call
  // per ACTIVE campaign (18 recently) rather than one per campaign (317).
  { job: "sync-instantly-day-stats", everyMinutes: 180 },
  /*
   * Replies incrementally, off a watermark with a 48h overlap. Kept to 30
   * minutes rather than 10 like sync-replies: at 20 requests a minute a run
   * that needs several pages takes real time, and two overlapping runs would
   * spend the same tiny budget twice.
   */
  { job: "sync-instantly-replies", everyMinutes: 30 },
  // The nightly full walk: ~227 pages, about eleven minutes at the documented
  // rate. Placed after every EmailBison sweep so the two never contend.
  { job: "sync-instantly-replies-deep", dailyAtUtcHour: 12 },
  { job: "sync-instantly-day-stats-deep", dailyAtUtcHour: 13 },
  // 3 requests for the whole estate, so cheap enough to run with the rest.
  { job: "sync-instantly-account-stats", everyMinutes: 180 },
  { job: "sync-instantly-account-stats-deep", dailyAtUtcHour: 15 },
  // A draining queue: ~8 minutes of real work per run while history is
  // incomplete, then a single call that finds nothing and stops.
  { job: "sync-instantly-replies-backfill", everyMinutes: 30 },
  /*
   * Draining queue: real work while eleven months of daily history are missing,
   * a no-op the moment it reaches the floor. 30 minutes because each run is
   * ~120 API calls and there is no hurry — nothing depends on it finishing by a
   * particular time, only on it finishing.
   */
  { job: "sync-instantly-day-stats-backfill", everyMinutes: 30 },
] as const satisfies readonly ScheduleEntry[];

/*
 * Both directions, enforced by the compiler rather than by remembering:
 *
 *   - a scheduled name that isn't a registered job fails the `satisfies` above;
 *   - a registered job that is never scheduled fails here.
 *
 * The second is the one worth catching. Adding a job and forgetting to schedule
 * it has no symptom at all — no error, no log line, just a table that quietly
 * stops updating.
 */
type Unscheduled = Exclude<JobName, (typeof SCHEDULE)[number]["job"]>;
const _everyJobIsScheduled: Unscheduled extends never ? true : Unscheduled = true;
void _everyJobIsScheduled;

/**
 * SCHEDULE widened back to the interface.
 *
 * `as const` is what preserves the literal job names for the checks above, but
 * it also means each entry's type only carries the one cadence key it uses, so
 * `entry.everyMinutes` is a type error on a daily entry. Consumers that want to
 * read either key uniformly read this instead.
 */
export const SCHEDULE_ENTRIES: readonly ScheduleEntry[] = SCHEDULE;

/**
 * Which jobs are due at this instant.
 *
 * Pure and modulo-based rather than stateful, so it never drifts: a process
 * that restarts at 14:37 resumes the same cadence as one that has been up for a
 * week, and the schedule is testable without waiting an hour.
 */
export function dueJobs(
  now: Date,
  schedule: readonly ScheduleEntry[] = SCHEDULE,
): string[] {
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();
  const minuteOfDay = hour * 60 + minute;

  return schedule
    .filter((entry) =>
      entry.everyMinutes
        ? minuteOfDay % entry.everyMinutes === 0
        : minute === 0 && hour === entry.dailyAtUtcHour,
    )
    .map((entry) => entry.job);
}

/**
 * Every job that came due in the `windowMinutes` ending now.
 *
 * This is what a Railway cron dispatcher uses, and the window is not optional
 * padding. `dueJobs` matches an exact minute, but a cron container does not
 * start on the exact minute — Railway queues it, pulls the image and boots
 * Node, so a job scheduled for 06:00 is typically evaluated at 06:00:40 or
 * later. Matching on the wall clock at that point would miss every daily job,
 * every time, and the symptom would be a nightly sweep that simply never ran.
 *
 * Call it with a window equal to the cron interval: each scheduled minute then
 * falls in exactly one window, so nothing fires twice and nothing is skipped.
 * A dispatch that is missed entirely is still a non-event — the jobs are
 * idempotent and the next window re-covers whatever it can.
 */
export function dueJobsSince(
  now: Date,
  windowMinutes: number,
  schedule: readonly ScheduleEntry[] = SCHEDULE,
): string[] {
  const due = new Set<string>();
  for (let back = 0; back < windowMinutes; back++) {
    for (const job of dueJobs(new Date(now.getTime() - back * 60_000), schedule)) {
      due.add(job);
    }
  }
  return [...due];
}

/** Stable key for "this minute", so a tick that fires twice only runs jobs once. */
export function minuteKey(now: Date): number {
  return Math.floor(now.getTime() / 60_000);
}
