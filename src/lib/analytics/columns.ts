import {
  compactNumber,
  duration,
  fullNumber,
  percent,
  ratio,
} from "./format.ts";
import {
  bounceRate,
  humanRate,
  leadToEmail,
  positiveRate,
  replyRate,
} from "./metrics.ts";

/*
 * The Campaigns-table column registry.
 *
 * One place defines what a column is called, which group it belongs to, how it
 * renders, and whether it's on by default. The picker, the header, the body and
 * the localStorage preferences all read from here — so adding a column is one
 * entry, not four edits that can drift.
 */

export interface CampaignRow {
  /*
   * A NUMBER on EmailBison and a UUID STRING on Instantly. The two platforms
   * key their campaigns differently and nothing here needs to do arithmetic on
   * an id — it is a React key and a link target.
   */
  campaignId: number | string;
  /** Which platform the row came from; decides what it can and cannot report. */
  platform?: "emailbison" | "instantly";
  campaignName: string;
  clientName: string | null;
  status: string | null;
  /*
   * Steps only. A variant is an alternative WORDING of one step — EmailBison
   * gives it order = null and variant_from_step_id = <step> — so a lead still
   * receives one email at that position. Counting variants made a 3-step
   * sequence read as 4.
   */
  stepCount: number;
  variantCount: number;
  sent: number;
  prospects: number;
  replies: number;
  humanReplies: number;
  /*
   * NULLABLE, because Instantly cannot report them.
   *
   * Positive is decided by MasterInbox labels, which key on EmailBison reply
   * ids — so an Instantly row has no Positive and no sentiment split, and the
   * per-reply timings and outcome counts have no Instantly equivalent either.
   * Null renders as a dash; a 0 would claim none of those replies were
   * positive, which is a different and false statement.
   */
  positive: number | null;
  negative: number | null;
  neutral: number | null;
  botReplies: number | null;
  bounces: number | null;
  medianReplySeconds: number | null;
  /*
   * The mean beside the median. They answer different questions: the median is
   * the typical prospect, the mean is dragged by the one who replied three
   * weeks later — and a wide gap between them is itself the finding.
   */
  avgReplySeconds: number | null;
  /*
   * How fast WE answer — a measure of the team, not the copy. Comes from the
   * portal, because the team replies from its inbox and EmailBison's thread
   * therefore holds no follow-up at all. Null below a usable sample size.
   */
  medianFollowUpSeconds: number | null;
  followUpSampleSize: number | null;
  /*
   * Derived from the bounce notification's subject, NOT from EmailBison, which
   * exposes only a single `bounced` total. hard + soft will not sum exactly to
   * `bounces` — a handful of bounces produce no notification we stored — which
   * is why these are named for the classification rather than for "bounces".
   */
  // Null on Instantly: it reports a bounce total but no hard/soft split.
  bouncesHard: number | null;
  bouncesSoft: number | null;
  /*
   * Outcome counts, attributed to this campaign (WT §7). Only outcomes we can
   * PROVE this campaign earned are here, so these sum to less than the
   * Attribution tab's totals — Instantly and unmatched outcomes belong to no
   * campaign. Spreading them would be the error 025 exists to prevent.
   */
  /*
   * Null on Instantly rather than 0. Outcomes reach this product through the
   * MasterInbox feed and are credited only to campaigns it can PROVE — an
   * Instantly campaign has none attributed here, and printing 0 hires would
   * assert it earned none rather than that none can be traced to it.
   */
  introductions: number | null;
  phoneScreens: number | null;
  interviews: number | null;
  hires: number | null;
  outcomesTotal: number | null;
}

export type ColumnGroup =
  | "Volume"
  | "Rates"
  | "Reply Sentiment"
  | "Reply Source"
  | "Timing"
  | "Events";

export interface ColumnDef {
  key: string;
  label: string;
  group: ColumnGroup;
  defaultVisible: boolean;
  render: (row: CampaignRow) => string;
  /** Draws attention when non-zero — the reference underlines Bounces. */
  emphasizeNonZero?: boolean;
  /*
   * The raw comparable value. PRESENT MEANS SORTABLE.
   *
   * It has to be separate from `render`, which returns a formatted string —
   * "1 : 700" and "2.9d" do not compare numerically, and sorting on them would
   * silently order by text.
   *
   * It is a property of the column rather than a list kept beside it, which is
   * the bug this replaces: `SORTABLE` carried "positive", no column has that
   * key (it is `sentimentPositive`), and so one of its five entries had never
   * done anything. A definition-level field makes that unwritable.
   */
  sortValue?: (row: CampaignRow) => number | string | null;
}

export const COLUMNS: ColumnDef[] = [
  // Volume
  { key: "sent", label: "Sent", group: "Volume", defaultVisible: true, render: (r) => fullNumber(r.sent), sortValue: (r) => r.sent },
  { key: "prospects", label: "Prospects", group: "Volume", defaultVisible: false, render: (r) => fullNumber(r.prospects), sortValue: (r) => r.prospects },
  { key: "replies", label: "Replies", group: "Volume", defaultVisible: true, render: (r) => fullNumber(r.replies), sortValue: (r) => r.replies },
  {
    key: "bounces",
    label: "Bounces",
    group: "Volume",
    defaultVisible: true,
    render: (r) => fullNumber(r.bounces),
    emphasizeNonZero: true,
  },

  // Rates
  { key: "replyRate", label: "Reply %", group: "Rates", defaultVisible: true, render: (r) => percent(replyRate(r.replies, r.sent), 2), sortValue: (r) => replyRate(r.replies, r.sent) },
  { key: "humanRate", label: "Human %", group: "Rates", defaultVisible: true, render: (r) => percent(humanRate(r.humanReplies, r.sent), 2), sortValue: (r) => humanRate(r.humanReplies, r.sent) },
  /*
   * A rate whose numerator is unknown is UNKNOWN, not zero. An Instantly row
   * has no Positive — MasterInbox owns it — and computing 0/884 would print
   * "0.00%" beside 884 replies, which reads as a campaign that converted
   * nobody rather than one whose replies have not been labelled.
   */
  { key: "positiveRate", label: "Positive %", group: "Rates", defaultVisible: true, render: (r) => percent(r.positive == null ? null : positiveRate(r.positive, r.replies), 2), sortValue: (r) => (r.positive == null ? null : positiveRate(r.positive, r.replies)) },
  { key: "bounceRate", label: "Bounce %", group: "Rates", defaultVisible: false, render: (r) => percent(r.bounces == null ? null : bounceRate(r.bounces, r.sent), 2), sortValue: (r) => (r.bounces == null ? null : bounceRate(r.bounces, r.sent)) },
  /*
   * A "soft" bounce is a delay — a receiving server asking us to retry — and
   * EmailBison counts it in the same total as a permanent failure. Live data:
   * 605 of 4,133 bounce notifications are delays, and one campaign is 33%
   * delays, so its real failure rate is a third lower than the headline. Hard
   * is the number that should drive suppression decisions.
   */
  { key: "bouncesHard", label: "Hard", group: "Rates", defaultVisible: false, render: (r) => fullNumber(r.bouncesHard), sortValue: (r) => r.bouncesHard },
  { key: "bouncesSoft", label: "Soft (delay)", group: "Rates", defaultVisible: false, render: (r) => fullNumber(r.bouncesSoft), sortValue: (r) => r.bouncesSoft },
  { key: "hardBounceRate", label: "Hard %", group: "Rates", defaultVisible: false, render: (r) => percent(r.bouncesHard == null ? null : bounceRate(r.bouncesHard, r.sent), 2), sortValue: (r) => (r.bouncesHard == null ? null : bounceRate(r.bouncesHard, r.sent)) },
  // "emails per positive reply" is meaningless without a Positive count, so an
  // Instantly row dashes rather than dividing by an unknown.
  { key: "leadToEmail", label: "Lead:Email", group: "Rates", defaultVisible: true, render: (r) => ratio(r.positive == null ? null : leadToEmail(r.sent, r.positive)), sortValue: (r) => (r.positive == null ? null : leadToEmail(r.sent, r.positive)) },

  /*
   * Reply sentiment — all three, at last.
   *
   * This group could only ever draw "+" because it read EmailBison's
   * `interested`, a positive signal with no negative counterpart. It now reads
   * the MasterInbox label (046/048), which carries all three: 384 positive,
   * 2,238 negative, 815 neutral in the last 90 days.
   *
   * A reply nobody has labelled yet counts in none of the three, which is why
   * they do not sum to Replies — and why that is correct rather than a gap.
   */
  { key: "sentimentPositive", label: "+", group: "Reply Sentiment", defaultVisible: false, render: (r) => fullNumber(r.positive), sortValue: (r) => r.positive },
  { key: "sentimentNeutral", label: "~", group: "Reply Sentiment", defaultVisible: false, render: (r) => fullNumber(r.neutral), sortValue: (r) => r.neutral },
  { key: "sentimentNegative", label: "−", group: "Reply Sentiment", defaultVisible: false, render: (r) => fullNumber(r.negative), sortValue: (r) => r.negative },

  // Reply source — EmailBison's own automated-reply heuristic.
  { key: "sourceHuman", label: "Human", group: "Reply Source", defaultVisible: false, render: (r) => fullNumber(r.humanReplies), sortValue: (r) => r.humanReplies },
  { key: "sourceBot", label: "Bot", group: "Reply Source", defaultVisible: false, render: (r) => fullNumber(r.botReplies), sortValue: (r) => r.botReplies },

  // Timing
  { key: "medianReply", label: "Median Reply", group: "Timing", defaultVisible: true, render: (r) => duration(r.medianReplySeconds), sortValue: (r) => r.medianReplySeconds },
  { key: "avgReply", label: "Avg Reply", group: "Timing", defaultVisible: false, render: (r) => duration(r.avgReplySeconds), sortValue: (r) => r.avgReplySeconds },
  { key: "medianFollowUp", label: "Median Follow-up", group: "Timing", defaultVisible: false, render: (r) => duration(r.medianFollowUpSeconds), sortValue: (r) => r.medianFollowUpSeconds },

  /*
   * Events (WT §5.3): "so you can read outcomes alongside reply rates in one
   * row". Off by default — most campaigns have none, and twenty extra zeroes
   * would push the columns anyone actually scans off the screen.
   *
   * `emailsPer` renders a ratio rather than a count: "how much sending buys one
   * of these", the same question Lead-to-Email answers for positives. DASH when
   * the campaign earned none, never a misleading 0 or Infinity.
   */
  { key: "introductions", label: "Intros", group: "Events", defaultVisible: false, render: (r) => fullNumber(r.introductions), sortValue: (r) => r.introductions },
  { key: "phoneScreens", label: "Phone Screens", group: "Events", defaultVisible: false, render: (r) => fullNumber(r.phoneScreens), sortValue: (r) => r.phoneScreens },
  { key: "interviews", label: "Interviews", group: "Events", defaultVisible: false, render: (r) => fullNumber(r.interviews), sortValue: (r) => r.interviews },
  { key: "hires", label: "Hires", group: "Events", defaultVisible: false, render: (r) => fullNumber(r.hires), sortValue: (r) => r.hires },
  { key: "outcomesTotal", label: "Outcomes", group: "Events", defaultVisible: false, render: (r) => fullNumber(r.outcomesTotal), sortValue: (r) => r.outcomesTotal },
  { key: "emailsPerIntro", label: "E:Intro", group: "Events", defaultVisible: false, render: (r) => ratio(r.introductions == null ? null : leadToEmail(r.sent, r.introductions)), sortValue: (r) => (r.introductions == null ? null : leadToEmail(r.sent, r.introductions)) },
  { key: "emailsPerHire", label: "E:Hire", group: "Events", defaultVisible: false, render: (r) => ratio(r.hires == null ? null : leadToEmail(r.sent, r.hires)), sortValue: (r) => (r.hires == null ? null : leadToEmail(r.sent, r.hires)) },
];

export const COLUMN_GROUPS: ColumnGroup[] = [
  "Volume",
  "Rates",
  "Reply Sentiment",
  "Reply Source",
  "Timing",
  "Events",
];

export const DEFAULT_VISIBLE = COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key);

/*
 * Bumped whenever the column set changes. The stored preference is discarded on
 * mismatch, so adding a column doesn't resurrect a stale selection that hides
 * it forever — the classic "why can't I see the new column" bug.
 */
export const COLUMN_PREFS_VERSION = 1;
export const COLUMN_PREFS_KEY = "bsa.campaign-columns.v1";


export { compactNumber };
