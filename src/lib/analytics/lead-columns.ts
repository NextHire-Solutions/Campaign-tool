import { DASH, fullNumber } from "./format.ts";

/*
 * The columns on a campaign's Leads tab.
 *
 * Same registry shape as columns.ts: adding a column is one entry here, not four
 * edits across the table, the picker, the header and the row.
 *
 * WHAT WE CANNOT SHOW, and why it is absent rather than approximated. The
 * reference screen (Instantly) carries three columns this data cannot fill:
 *
 *   Email Provider          only 36% of addresses are derivable from the domain
 *                           (Google 28.8%, Yahoo 3.3%, Microsoft 1.1%); the
 *                           other 64% are company domains needing a DNS lookup.
 *                           A column that is right a third of the time is worse
 *                           than no column. "Domain" is shipped instead — true,
 *                           sortable, and the thing you actually want when one
 *                           sending domain is misbehaving.
 *   Email Security Gateway  same lookup problem, no field anywhere.
 *   Website                 probed 2026-08-06: not on the EmailBison lead
 *                           object and not among this workspace's twelve custom
 *                           variables.
 */

export interface LeadRow {
  leadId: number;
  email: string | null;
  name: string | null;
  company: string | null;
  title: string | null;
  leadStatus: string | null;
  status: string;
  stepReached: number | null;
  /** Null when the lead is known contacted but no send row survives (072). */
  sends: number | null;
  firstSentAt: string | null;
  lastSentAt: string | null;
  opens: number | null;
  uniqueOpens: number | null;
  clicks: number | null;
  replies: number;
  positive: number;
  bounces: number;
  senderEmail: string | null;
  /** Every custom variable, name → value. Long not wide, so a new one upstream
   *  needs no migration — just an entry below. */
  attributes: Record<string, string>;
}

export const LEAD_COLUMN_GROUPS = ["Lead", "Sequence", "Engagement", "Attributes"] as const;
export type LeadColumnGroup = (typeof LEAD_COLUMN_GROUPS)[number];

export interface LeadColumnDef {
  key: string;
  label: string;
  group: LeadColumnGroup;
  defaultVisible: boolean;
  align?: "left" | "right";
  render: (row: LeadRow) => string;
  /** Present ⇒ sortable. The key the RPC understands, not a local accessor —
   *  this list is server-paginated, so the sort has to happen in SQL. */
  sortKey?: string;
}

const date = (value: string | null) =>
  value ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : DASH;

/** The twelve custom variables this workspace actually carries. */
const ATTRIBUTES: Array<[string, string]> = [
  ["phone number", "Phone"],
  ["office city", "Office city"],
  ["sales volume", "Sales volume"],
  ["mls affiliation", "MLS"],
  ["top producing city", "Top city"],
  ["estimated gci", "Est. GCI"],
  ["closed transactions", "Closed"],
  ["average sales price", "Avg price"],
  ["closed rentals", "Rentals"],
  ["buy-side", "Buy-side"],
  ["list-side", "List-side"],
  ["courted profile", "Courted"],
];

export const LEAD_COLUMNS: LeadColumnDef[] = [
  { key: "company", label: "Company", group: "Lead", defaultVisible: true, align: "left",
    // 027 is emphatic that this is the lead's CURRENT employer, never the client.
    render: (r) => r.company || DASH, sortKey: "company" },
  { key: "title", label: "Title", group: "Lead", defaultVisible: false, align: "left",
    render: (r) => r.title || DASH, sortKey: "title" },
  { key: "domain", label: "Domain", group: "Lead", defaultVisible: false, align: "left",
    render: (r) => r.email?.split("@")[1] || DASH },
  { key: "status", label: "Status", group: "Lead", defaultVisible: true, align: "left",
    render: (r) => r.status, sortKey: "status" },

  { key: "stepReached", label: "Step", group: "Sequence", defaultVisible: true,
    render: (r) => (r.stepReached == null ? DASH : String(r.stepReached)), sortKey: "step_reached" },
  { key: "sends", label: "Sent", group: "Sequence", defaultVisible: true,
    render: (r) => fullNumber(r.sends), sortKey: "sends" },
  { key: "firstSentAt", label: "First contacted", group: "Sequence", defaultVisible: false,
    render: (r) => date(r.firstSentAt), sortKey: "first_sent_at" },
  { key: "lastSentAt", label: "Last contacted", group: "Sequence", defaultVisible: true,
    render: (r) => date(r.lastSentAt), sortKey: "last_sent_at" },
  { key: "senderEmail", label: "Sent from", group: "Sequence", defaultVisible: false, align: "left",
    render: (r) => r.senderEmail || DASH },

  { key: "opens", label: "Opens", group: "Engagement", defaultVisible: true,
    render: (r) => fullNumber(r.opens), sortKey: "opens" },
  { key: "uniqueOpens", label: "Unique opens", group: "Engagement", defaultVisible: false,
    render: (r) => fullNumber(r.uniqueOpens), sortKey: "unique_opens" },
  { key: "clicks", label: "Clicks", group: "Engagement", defaultVisible: false,
    render: (r) => fullNumber(r.clicks), sortKey: "clicks" },
  /*
   * Replies / Positive / Bounces are joined from `replies` at read time, never
   * from the send feed — rule 3, one authority per metric family. A lead's reply
   * count here therefore agrees with the Replies tab and the KPI band.
   */
  { key: "replies", label: "Replies", group: "Engagement", defaultVisible: true,
    render: (r) => fullNumber(r.replies) },
  { key: "positive", label: "Positive", group: "Engagement", defaultVisible: false,
    render: (r) => fullNumber(r.positive) },
  { key: "bounces", label: "Bounces", group: "Engagement", defaultVisible: false,
    render: (r) => fullNumber(r.bounces) },

  ...ATTRIBUTES.map(([name, label]): LeadColumnDef => ({
    key: `attr:${name}`,
    label,
    group: "Attributes",
    defaultVisible: name === "phone number",
    align: "left",
    render: (r) => r.attributes?.[name] || DASH,
  })),
];

export const LEAD_DEFAULT_VISIBLE = LEAD_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key);
export const LEAD_COLUMN_PREFS_KEY = "bsa.campaign-lead-columns.v1";
export const LEAD_COLUMN_PREFS_VERSION = 1;

/** Plain-language names for the derived per-campaign status. */
export const LEAD_STATUS_LABELS: Record<string, string> = {
  contacted: "Contacted",
  completed: "Finished the sequence",
  replied: "Replied",
  positive: "Positive reply",
  bounced: "Bounced",
};
