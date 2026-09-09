import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { SCHEDULE_ENTRIES, dueJobs, dueJobsSince, minuteKey } from "./schedule.ts";

const entries = SCHEDULE_ENTRIES;

/*
 * The two "does every job exist / is every job scheduled" checks are enforced
 * by the compiler in schedule.ts, not here — importing the registry would drag
 * the whole Supabase and EmailBison chain into a unit test.
 */

const at = (hh: number, mm: number) =>
  new Date(Date.UTC(2026, 6, 15, hh, mm, 0));

describe("sync schedule", () => {
  it("gives every entry exactly one cadence", () => {
    for (const entry of entries) {
      const hasInterval = entry.everyMinutes !== undefined;
      const hasDaily = entry.dailyAtUtcHour !== undefined;
      assert.ok(hasInterval !== hasDaily, `${entry.job} must have one cadence, not both or neither`);
    }
  });

  it("fires the 10-minute job on tens and nothing else off-cadence", () => {
    assert.ok(dueJobs(at(14, 10)).includes("sync-replies"));
    assert.ok(dueJobs(at(14, 20)).includes("sync-replies"));
    assert.deepEqual(dueJobs(at(14, 7)), []);
  });

  it("stacks the coarser cadences on the hour", () => {
    /*
     * Derived from the schedule rather than hardcoded. A literal list turned
     * this into a chore — adding an hourly job failed it without anything being
     * wrong — while asserting the RULE still catches a genuine cadence bug.
     * 14:00 is minute-of-day 840: divisible by 10, 30 and 60, not by 180.
     *
     * NIGHTLY JOBS AT THIS HOUR COUNT TOO. Deriving only from `everyMinutes`
     * quietly assumed nothing daily was scheduled at 14:00, so the first job
     * placed there failed this test with nothing wrong — the same chore the
     * comment above says was designed out, reintroduced through the other
     * cadence.
     */
    const minuteOfDay = 14 * 60;
    const expected = entries
      .filter(
        (e) =>
          (e.everyMinutes && minuteOfDay % e.everyMinutes === 0) ||
          e.dailyAtUtcHour === 14,
      )
      .map((e) => e.job)
      .sort();

    assert.deepEqual(dueJobs(at(14, 0)).sort(), expected);
    assert.ok(expected.includes("sync-replies"), "the 10-minute job must be due on the hour");
    assert.ok(
      !expected.includes("sync-day-stats"),
      "the 3-hourly job must NOT be due at 14:00",
    );
  });

  it("fires the 3-hourly job only on multiples of three hours", () => {
    assert.ok(dueJobs(at(12, 0)).includes("sync-day-stats"));
    assert.ok(!dueJobs(at(13, 0)).includes("sync-day-stats"));
  });

  it("fires each nightly job once, at its own hour", () => {
    for (const entry of entries.filter((e) => e.dailyAtUtcHour !== undefined)) {
      const hour = entry.dailyAtUtcHour!;
      assert.ok(dueJobs(at(hour, 0)).includes(entry.job));
      // Not at :30 — a daily job that fired every minute of its hour would make
      // 60 full sweeps a night.
      assert.ok(!dueJobs(at(hour, 30)).includes(entry.job));
    }
  });

  it("staggers the nightly sweeps so they never collide", () => {
    const hours = entries.filter((e) => e.dailyAtUtcHour !== undefined).map(
      (e) => e.dailyAtUtcHour,
    );
    assert.equal(new Set(hours).size, hours.length, "two nightly jobs share an hour");
  });

  it("catches a job through the whole dispatch window, not just on the minute", () => {
    // A Railway cron container for 06:00 typically evaluates at 06:00:40+.
    // Exact-minute matching would miss every nightly job, every night.
    const late = new Date(Date.UTC(2026, 6, 15, 6, 7, 12));
    assert.ok(!dueJobs(late).includes("sync-steps"));
    assert.ok(dueJobsSince(late, 10).includes("sync-steps"));
  });

  it("fires each scheduled minute in exactly one window", () => {
    // Windows equal to the cron interval must tile the day: every job occurrence
    // lands in one window, so nothing is skipped and nothing is double-fired.
    const counts = new Map<string, number>();
    for (let minute = 0; minute < 24 * 60; minute += 10) {
      const at10 = new Date(Date.UTC(2026, 6, 15, 0, 0) + minute * 60_000);
      for (const job of dueJobsSince(at10, 10)) {
        counts.set(job, (counts.get(job) ?? 0) + 1);
      }
    }
    assert.equal(counts.get("sync-replies"), 144); // 24h / 10min
    assert.equal(counts.get("sync-entities"), 48);
    assert.equal(counts.get("sync-daily-series"), 24);
    assert.equal(counts.get("sync-day-stats"), 8); // every 3h
    for (const entry of entries.filter((e) => e.dailyAtUtcHour !== undefined)) {
      assert.equal(counts.get(entry.job), 1, `${entry.job} should fire exactly once a day`);
    }
  });

  it("keys ticks by the minute", () => {
    assert.equal(minuteKey(at(14, 10)), minuteKey(new Date(at(14, 10).getTime() + 59_000)));
    assert.notEqual(minuteKey(at(14, 10)), minuteKey(at(14, 11)));
  });
});
