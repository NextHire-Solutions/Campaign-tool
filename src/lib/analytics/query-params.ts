import { z } from "zod";
import { DEFAULT_SERIES, SERIES_KEYS, type SeriesKey } from "./series.ts";

/*
 * The shared filter contract, parsed and validated in exactly ONE place.
 *
 * The same schema runs in the client hook (useAnalyticsFilters) and in every
 * API route. That is the point: if the client and the server ever disagreed
 * about what "7d" means or whether `to` is inclusive, every number on the page
 * would be subtly wrong in a way no test would catch. Sharing the parser makes
 * that class of bug structurally impossible.
 *
 * Conventions, fixed here and nowhere else:
 *   - Dates are PLAIN `YYYY-MM-DD`, never ISO timestamps. Timezone resolution
 *     happens once, server-side, from teams.timezone.
 *   - `[from, to]` is INCLUSIVE at both ends. "7d" is today plus the 6 before.
 *   - Arrays are comma-joined, not repeated keys — shorter URLs, one parse path.
 *   - Unknown params are dropped rather than passed through.
 */

export const PRESETS = ["7d", "30d", "90d", "custom"] as const;
export type Preset = (typeof PRESETS)[number];

export const SUB_VIEWS = ["charts", "clients", "campaigns", "replies"] as const;
export type SubView = (typeof SUB_VIEWS)[number];

/*
 * Sending platforms present in the data.
 *
 * This stopped being cosmetic when the outcomes feed proved both are live: its
 * campaign_id holds an EmailBison integer for some rows and an Instantly UUID
 * for others (see 025_outcome_platform.sql).
 *
 * IT IS ONLY MEANINGFUL ON ATTRIBUTION, and that asymmetry is real rather than
 * an oversight. Every send, reply, sender and campaign this dashboard holds
 * comes from EmailBison; Instantly appears solely as the source of an outcome.
 * So selecting Instantly correctly empties the sending tabs — we hold none of
 * its sending data — and the filter bar says so rather than letting a blank
 * chart read as a bug.
 */
export const PLATFORMS = ["emailbison", "instantly"] as const;
export type Platform = (typeof PLATFORMS)[number];

const PRESET_DAYS: Record<Exclude<Preset, "custom">, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

// --- plain-date helpers ------------------------------------------------------
// All arithmetic goes through UTC so a machine in UTC-8 doesn't silently shift
// the range by a day. These operate on calendar dates, not instants.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseISODate(value: string): Date {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(value: string, days: number): string {
  const date = parseISODate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return toISODate(date);
}

/** Inclusive day count: daysBetween("2026-07-01", "2026-07-01") === 1. */
export function daysBetween(from: string, to: string): number {
  const ms = parseISODate(to).getTime() - parseISODate(from).getTime();
  return Math.round(ms / 86_400_000) + 1;
}

// --- schema ------------------------------------------------------------------

const isoDate = z.string().regex(DATE_RE, "Expected YYYY-MM-DD");

/**
 * Comma-joined list → deduped, parsed array. Empty string → `[]`, never `[""]`.
 *
 * Takes a parse function rather than a zod item schema: `.pipe(z.array(...))`
 * can't express "the input is always a string but the output isn't", and
 * hand-rolling the loop also lets a bad entry report WHICH entry was bad.
 */
function csvOf<T>(parse: (raw: string) => T, what: string) {
  return z
    .string()
    .optional()
    .transform((value, ctx): T[] => {
      if (!value) return [];
      const out: T[] = [];
      for (const raw of new Set(
        value.split(",").map((s) => s.trim()).filter(Boolean),
      )) {
        try {
          out.push(parse(raw));
        } catch {
          ctx.addIssue({
            code: "custom",
            message: `Invalid ${what}: ${raw}`,
          });
        }
      }
      return out;
    });
}

/**
 * Repeated param → deduped array of raw strings. `?k=a&k=b` → `["a","b"]`.
 *
 * NOT comma-split, and that is the whole point. The reply facets carry values
 * straight from lead data, and every Location value is of the form
 * "Charlotte, NC" — so `csvOf` tore each one into "Charlotte" and "NC", neither
 * of which matches anything, and the Location filter returned zero replies for
 * every value it itself offered. Ids, uuids, platforms and series keys cannot
 * contain a comma, so they keep the shorter CSV encoding.
 *
 * A bare string is still accepted so a hand-edited single-value URL works.
 */
function listOf() {
  return z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value): string[] => {
      if (value == null) return [];
      const items = Array.isArray(value) ? value : [value];
      return [...new Set(items.map((s) => s.trim()).filter(Boolean))];
    });
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/*
 * A campaign id from EITHER platform, kept as text.
 *
 * EmailBison keys with a bigint and Instantly with a uuid, and the picker now
 * offers both — so this one filter has to carry both. Text is the only type
 * that holds them without lying about either; the derived arrays below hand
 * each route exactly the ids its own tables understand.
 *
 * The two spaces cannot collide (a uuid is never a valid bigint), which is what
 * makes splitting them by shape afterwards sound rather than a guess.
 */
function parseCampaignId(raw: string): string {
  if (UUID_RE.test(raw)) return raw;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new Error("not a campaign id");
  return String(id);
}

function parseUuid(raw: string): string {
  if (!UUID_RE.test(raw)) throw new Error("not a uuid");
  return raw;
}

function parsePlatform(raw: string): Platform {
  if (!(PLATFORMS as readonly string[]).includes(raw)) {
    throw new Error("unknown platform");
  }
  return raw as Platform;
}

function parseSeries(raw: string): SeriesKey {
  if (!(SERIES_KEYS as readonly string[]).includes(raw)) {
    throw new Error("unknown series");
  }
  return raw as SeriesKey;
}

const boolish = z
  .string()
  .optional()
  .transform((value) => value === "1" || value === "true");

export const filtersSchema = z.object({
  preset: z.enum(PRESETS).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  campaign_ids: csvOf(parseCampaignId, "campaign id"),
  client_ids: csvOf(parseUuid, "client id"),
  platforms: csvOf(parsePlatform, "platform"),
  /*
   * Reply attribute filters (REQ page 2). One param per dimension, values
   * comma-separated. Kept free-text rather than an enum because the vocabulary
   * IS the data — brokerage names and cities come from leads and change without
   * a deploy, which is the same reason reply_dimensions is a table.
   */
  reply_company: listOf(),
  reply_location: listOf(),
  reply_sales_volume: listOf(),
  compare: boolish,
  // Charts-only. Parsed here so the routes share one validator.
  view: z.enum(SUB_VIEWS).optional(),
  series: csvOf(parseSeries, "series"),
  mode: z.enum(["volume", "rates"]).optional(),
  exclude_weekends: boolish,
  normalize: boolish,
});

export interface ResolvedFilters {
  preset: Preset;
  from: string;
  to: string;
  /** Every selected campaign, as text — both platforms share this filter. */
  campaignIds: string[];
  /** The EmailBison half, as the integers its tables key on. */
  emailbisonCampaignIds: number[];
  /** The Instantly half, as the uuids its tables key on. */
  instantlyCampaignIds: string[];
  clientIds: string[];
  /** Empty = every platform, which is what an absent filter means. */
  platforms: Platform[];
  /** Reply attribute filters, keyed by reply_dimensions.key. */
  replyFacets: Record<string, string[]>;
  compare: boolean;
  /** Present only when `compare` is on. */
  compareFrom?: string;
  compareTo?: string;
  view: SubView;
  series: SeriesKey[];
  mode: "volume" | "rates";
  excludeWeekends: boolean;
  normalize: boolean;
}

/**
 * Resolves a raw query string into the concrete range every downstream query
 * uses. `today` is injected rather than read from the clock so this is pure and
 * testable, and so the server can resolve "today" in the team's timezone.
 */
/** Params carried as `?k=a&k=b` rather than `?k=a,b` — see `listOf`. */
const REPEATED_KEYS = ["reply_company", "reply_location", "reply_sales_volume"] as const;

export function resolveFilters(
  params: URLSearchParams | Record<string, string | undefined>,
  today: string,
): ResolvedFilters {
  /*
   * `Object.fromEntries` keeps only the LAST value of a repeated param, so the
   * facet keys are collected with getAll() before the collapse. Everything else
   * is single-valued or comma-joined and is unaffected.
   */
  const raw: Record<string, unknown> =
    params instanceof URLSearchParams
      ? {
          ...Object.fromEntries(params.entries()),
          ...Object.fromEntries(
            REPEATED_KEYS.filter((k) => params.has(k)).map((k) => [k, params.getAll(k)]),
          ),
        }
      : (params as Record<string, unknown>);

  const parsed = filtersSchema.parse(raw);

  // An explicit from/to pair wins and forces `custom`. Otherwise the preset
  // decides, defaulting to 30d — the reference product's default.
  let preset: Preset = parsed.preset ?? (parsed.from && parsed.to ? "custom" : "30d");
  let from: string;
  let to: string;

  if (preset === "custom" && parsed.from && parsed.to) {
    from = parsed.from;
    to = parsed.to;
  } else {
    if (preset === "custom") preset = "30d"; // custom with no dates is meaningless
    to = today;
    from = addDays(today, -(PRESET_DAYS[preset as Exclude<Preset, "custom">] - 1));
  }

  // Guard against an inverted range arriving from a hand-edited URL.
  if (from > to) [from, to] = [to, from];

  const resolved: ResolvedFilters = {
    preset,
    from,
    to,
    campaignIds: parsed.campaign_ids,
    /*
     * Split by shape, once, here — so no route has to work out which ids it can
     * use and none can accidentally send a uuid to a bigint column.
     */
    emailbisonCampaignIds: parsed.campaign_ids
      .filter((id) => !UUID_RE.test(id))
      .map(Number),
    instantlyCampaignIds: parsed.campaign_ids.filter((id) => UUID_RE.test(id)),
    clientIds: parsed.client_ids,
    platforms: parsed.platforms,
    replyFacets: {
      company: parsed.reply_company,
      location: parsed.reply_location,
      sales_volume: parsed.reply_sales_volume,
    },
    compare: parsed.compare,
    view: parsed.view ?? "charts",
    series: parsed.series.length ? parsed.series : DEFAULT_SERIES,
    mode: parsed.mode ?? "volume",
    excludeWeekends: parsed.exclude_weekends,
    normalize: parsed.normalize,
  };

  if (resolved.compare) {
    const { from: cFrom, to: cTo } = comparePeriod(from, to);
    resolved.compareFrom = cFrom;
    resolved.compareTo = cTo;
  }

  return resolved;
}

/**
 * The immediately preceding window of identical length, ending the day before
 * `from`. Derived here and returned by the API so the UI can never render a
 * label describing a different period than the query actually used.
 */
export function comparePeriod(
  from: string,
  to: string,
): { from: string; to: string } {
  const length = daysBetween(from, to);
  const compareTo = addDays(from, -1);
  return { from: addDays(compareTo, -(length - 1)), to: compareTo };
}

/** Serialises resolved filters back to a query string, omitting defaults. */
export function filtersToSearchParams(
  filters: Partial<ResolvedFilters>,
): URLSearchParams {
  const params = new URLSearchParams();
  const set = (key: string, value: string | undefined) => {
    if (value) params.set(key, value);
  };
  const setList = (key: string, values?: Array<string | number>) => {
    if (values?.length) params.set(key, values.join(","));
  };

  if (filters.preset === "custom") {
    set("preset", "custom");
    set("from", filters.from);
    set("to", filters.to);
  } else if (filters.preset && filters.preset !== "30d") {
    set("preset", filters.preset);
  }

  setList("campaign_ids", filters.campaignIds);
  setList("client_ids", filters.clientIds);
  setList("platforms", filters.platforms);
  // Appended one by one, not comma-joined: a facet value may contain a comma.
  for (const [key, values] of Object.entries(filters.replyFacets ?? {})) {
    for (const value of values ?? []) params.append(`reply_${key}`, value);
  }
  if (filters.compare) params.set("compare", "1");
  if (filters.view && filters.view !== "charts") params.set("view", filters.view);

  // Only serialise the series selection when it differs from the default —
  // otherwise every URL carries `series=replies` for no reason, and a shared
  // link looks like someone deliberately narrowed the chart.
  const isDefaultSeries =
    filters.series?.length === DEFAULT_SERIES.length &&
    filters.series.every((key, i) => key === DEFAULT_SERIES[i]);
  if (!isDefaultSeries) setList("series", filters.series);

  if (filters.mode === "rates") params.set("mode", "rates");
  if (filters.excludeWeekends) params.set("exclude_weekends", "1");
  if (filters.normalize) params.set("normalize", "1");

  return params;
}
