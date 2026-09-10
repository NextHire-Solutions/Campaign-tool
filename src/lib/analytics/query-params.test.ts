import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  addDays,
  comparePeriod,
  daysBetween,
  filtersToSearchParams,
  resolveFilters,
} from "./query-params.ts";

const TODAY = "2026-07-30";

function resolve(query: string) {
  return resolveFilters(new URLSearchParams(query), TODAY);
}

describe("date helpers", () => {
  test("daysBetween is inclusive at both ends", () => {
    assert.equal(daysBetween("2026-07-30", "2026-07-30"), 1);
    assert.equal(daysBetween("2026-07-24", "2026-07-30"), 7);
  });

  test("addDays crosses month and year boundaries", () => {
    assert.equal(addDays("2026-07-01", -1), "2026-06-30");
    assert.equal(addDays("2026-01-01", -1), "2025-12-31");
    assert.equal(addDays("2026-02-28", 1), "2026-03-01"); // 2026 is not a leap year
  });
});

describe("presets", () => {
  test("7d is today plus the six days before it", () => {
    const f = resolve("preset=7d");
    assert.equal(f.to, TODAY);
    assert.equal(f.from, "2026-07-24");
    assert.equal(daysBetween(f.from, f.to), 7);
  });

  test("30d is the default when nothing is specified", () => {
    const f = resolve("");
    assert.equal(f.preset, "30d");
    assert.equal(f.from, "2026-07-01");
    assert.equal(f.to, "2026-07-30");
    assert.equal(daysBetween(f.from, f.to), 30);
  });

  test("90d spans ninety inclusive days", () => {
    const f = resolve("preset=90d");
    assert.equal(daysBetween(f.from, f.to), 90);
  });

  test("an explicit range forces custom", () => {
    const f = resolve("from=2026-06-01&to=2026-06-15");
    assert.equal(f.preset, "custom");
    assert.equal(f.from, "2026-06-01");
    assert.equal(f.to, "2026-06-15");
  });

  test("custom without dates falls back to 30d rather than breaking", () => {
    const f = resolve("preset=custom");
    assert.equal(f.preset, "30d");
    assert.equal(daysBetween(f.from, f.to), 30);
  });

  test("an inverted hand-edited range is corrected, not rejected", () => {
    const f = resolve("from=2026-06-15&to=2026-06-01");
    assert.equal(f.from, "2026-06-01");
    assert.equal(f.to, "2026-06-15");
  });
});

describe("compare period", () => {
  test("is the preceding window of identical length, ending the day before", () => {
    const { from, to } = comparePeriod("2026-07-01", "2026-07-30");
    assert.equal(to, "2026-06-30");
    assert.equal(from, "2026-06-01");
    assert.equal(daysBetween(from, to), 30);
  });

  test("7d compares against the 7 days immediately before", () => {
    const { from, to } = comparePeriod("2026-07-24", "2026-07-30");
    assert.equal(from, "2026-07-17");
    assert.equal(to, "2026-07-23");
  });

  test("is only resolved when compare is on", () => {
    assert.equal(resolve("preset=7d").compareFrom, undefined);
    const on = resolve("preset=7d&compare=1");
    assert.equal(on.compareFrom, "2026-07-17");
    assert.equal(on.compareTo, "2026-07-23");
  });
});

describe("list params", () => {
  test("parses comma-joined ids and dedupes", () => {
    /*
     * TEXT, because one filter now carries both platforms — EmailBison keys
     * with a bigint and Instantly with a uuid, and no numeric type holds both.
     */
    const f = resolve("campaign_ids=12,7,12");
    assert.deepEqual(f.campaignIds, ["12", "7"]);
    assert.deepEqual(f.emailbisonCampaignIds, [12, 7]);
    assert.deepEqual(f.instantlyCampaignIds, []);
  });

  test("A UUID IS AN INSTANTLY CAMPAIGN, AND THEY SPLIT CLEANLY", () => {
    /*
     * The split is what lets each route send only the ids its own tables
     * understand — a uuid reaching a bigint column is an error, and a bigint
     * reaching Instantly matches nothing.
     */
    const uuid = "4cb1ce6b-db02-4385-85f5-1ffeecdbb08c";
    const f = resolve(`campaign_ids=55,${uuid}`);
    assert.deepEqual(f.campaignIds, ["55", uuid]);
    assert.deepEqual(f.emailbisonCampaignIds, [55]);
    assert.deepEqual(f.instantlyCampaignIds, [uuid]);
  });

  test("a malformed campaign id is rejected, not coerced", () => {
    assert.throws(() => resolve("campaign_ids=not-an-id"));
    assert.throws(() => resolve("campaign_ids=0"));
    assert.throws(() => resolve("campaign_ids=-3"));
  });

  test("an empty list is [] rather than ['']", () => {
    assert.deepEqual(resolve("campaign_ids=").campaignIds, []);
  });

  test("rejects a non-uuid client id", () => {
    assert.throws(() => resolve("client_ids=not-a-uuid"));
  });
});

describe("chart params", () => {
  test("defaults to the charts view, volume mode, replies series", () => {
    const f = resolve("");
    assert.equal(f.view, "charts");
    assert.equal(f.mode, "volume");
    assert.deepEqual(f.series, ["replies"]);
    assert.equal(f.excludeWeekends, false);
    assert.equal(f.normalize, false);
  });

  test("parses an explicit series selection", () => {
    assert.deepEqual(resolve("series=sent,bounces").series, ["sent", "bounces"]);
  });

  test("rejects an unknown series rather than silently dropping it", () => {
    assert.throws(() => resolve("series=sent,wat"));
  });
});

describe("round-trip", () => {
  test("serialising then parsing preserves the filters", () => {
    const original = resolve(
      "preset=7d&campaign_ids=3,9&compare=1&view=campaigns&series=sent,positive&mode=rates&exclude_weekends=1",
    );
    const round = resolveFilters(filtersToSearchParams(original), TODAY);

    assert.equal(round.preset, original.preset);
    assert.equal(round.from, original.from);
    assert.equal(round.to, original.to);
    assert.deepEqual(round.campaignIds, original.campaignIds);
    assert.equal(round.compare, original.compare);
    assert.equal(round.view, original.view);
    assert.deepEqual(round.series, original.series);
    assert.equal(round.mode, original.mode);
    assert.equal(round.excludeWeekends, original.excludeWeekends);
  });

  test("omits defaults so the common URL stays clean", () => {
    const params = filtersToSearchParams(resolve(""));
    assert.equal(params.toString(), "");
  });

  test("unknown params are dropped, not carried through", () => {
    const params = filtersToSearchParams(resolve("utm_source=slack&preset=7d"));
    assert.equal(params.has("utm_source"), false);
  });
});

test("a reply facet value containing a comma survives the round trip", () => {
  // Every Location value is "City, ST". Comma-splitting turned "Charlotte, NC"
  // into two values that match nothing, so the filter returned zero replies for
  // a value the dropdown had just offered.
  const params = new URLSearchParams();
  params.append("reply_location", "Charlotte, NC");
  params.append("reply_location", "Beverly Hills, CA");
  const f = resolveFilters(params, "2026-08-05");
  assert.deepEqual(f.replyFacets.location, ["Charlotte, NC", "Beverly Hills, CA"]);
});

test("reply facets serialise as repeated params, not a comma list", () => {
  const query = filtersToSearchParams({
    replyFacets: { location: ["Charlotte, NC", "Miami, FL"] },
  });
  const back = resolveFilters(new URLSearchParams(query.toString()), "2026-08-05");
  assert.deepEqual(back.replyFacets.location, ["Charlotte, NC", "Miami, FL"]);
});

test("ids stay comma-joined — they can never contain a comma", () => {
  const f = resolveFilters(new URLSearchParams("campaign_ids=1,2,3"), "2026-08-05");
  assert.deepEqual(f.campaignIds, ["1", "2", "3"]);
});
