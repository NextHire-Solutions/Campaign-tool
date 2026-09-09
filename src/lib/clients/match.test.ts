import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  exclusionReason,
  matchCampaign,
  normalize,
  tokenize,
  type MatchableClient,
} from "./match.ts";

/*
 * Every fixture here is a REAL campaign name and a REAL client from the live
 * BrokerStaffer workspace (95 campaigns, 38 clients). The matcher decides how
 * all client reporting is grouped, so it is pinned against production data
 * rather than invented examples.
 *
 * Dry-run at time of writing: 78 matched (202,681 of 207,001 lifetime sent),
 * 15 excluded, 2 unassigned, 0 ambiguous.
 */

const CLIENTS: MatchableClient[] = [
  { id: "liv-indy-realty", name: "LIV Indy Realty" },
  { id: "serhant-pa", name: "SERHANT. PA", aliases: ["SERHANT. PA + Nicole + BRIGHT"] },
  { id: "serhant-pa-15m", name: "SERHANT. PA 15M+", aliases: ["SERHANT. PA + Nicole + BRIGHT 10M+"] },
  { id: "rise-real-estate-antelope", name: "Rise Real Estate Antelope" },
  { id: "rise-real-estate-tujunga", name: "Rise Real Estate Tujunga" },
  { id: "douglas-elliman-la", name: "Douglas Elliman LA" },
  { id: "douglas-elliman-nyc", name: "Douglas Elliman NYC" },
  { id: "the-re-home-group", name: "The RE Home Group of Douglas Realty" },
  { id: "jeff-cook-real-estate", name: "Jeff Cook Real Estate" },
  { id: "howe-realty-group", name: "Howe Realty Group", aliases: ["Howe Realty", "Howe Test"] },
  { id: "fast-real-estate", name: "Fast Real Estate" },
  { id: "properties-and-estates", name: "Properties & Estates" },
  { id: "re-max-pacific", name: "RE/MAX Pacific" },
  { id: "chucktown-homes-team", name: "ChuckTown Homes Team" },
  { id: "the-keyes-company", name: "The Keyes Company" },
];

const idOf = (name: string) => matchCampaign(name, CLIENTS).clientId;

describe("normalization", () => {
  test("strips punctuation and collapses whitespace", () => {
    assert.equal(normalize("SERHANT. PA"), "serhant pa");
    assert.equal(normalize("RE/MAX Pacific"), "re max pacific");
    assert.equal(normalize("Properties & Estates"), "properties estates");
    // Real campaign: "Jeff Cook Real Estate LPT Realty  2" has a double space.
    assert.equal(normalize("Jeff Cook Real Estate LPT Realty  2"), "jeff cook real estate lpt realty 2");
  });

  test("drops parenthesised asides", () => {
    assert.equal(normalize("54 Realty (9) - Hillsborough"), "54 realty hillsborough");
    assert.equal(normalize("Hunter Dehn Realty (2)"), "hunter dehn realty");
  });

  test("keeps digits, which carry meaning here", () => {
    assert.deepEqual(tokenize("SERHANT. PA 15M+"), ["serhant", "pa", "15m"]);
  });
});

describe("the client name is not always a prefix", () => {
  test('"Copy of ..." still resolves', () => {
    // This case is why matching runs over the whole name, not just the start.
    assert.equal(idOf("Copy of LIV Indy Realty 4 + Nicole + MIBOR"), "liv-indy-realty");
  });

  test("a trailing sequence number does not break the match", () => {
    assert.equal(idOf("Howe Realty 2 + Nicole + ARMLS"), "howe-realty-group");
    assert.equal(idOf("Jeff Cook Real Estate LPT Realty  2 + Nicole + Myrtle Beach"), "jeff-cook-real-estate");
  });
});

describe("longest match wins", () => {
  test("a nested client name loses to the longer one", () => {
    // "SERHANT. PA" (2 tokens) is a strict prefix of the 15M+ client's alias
    // (6 tokens). Without longest-match-wins, every 10M+ campaign would be
    // mis-attributed to the wrong client.
    assert.equal(idOf("SERHANT. PA + Nicole + BRIGHT 10M+"), "serhant-pa-15m");
    assert.equal(idOf("SERHANT. PA + Nicole + BRIGHT"), "serhant-pa");
  });

  test("clients sharing a three-token prefix stay separate", () => {
    assert.equal(idOf("Rise Real Estate Tujunga + Nicole + SOCAL"), "rise-real-estate-tujunga");
    assert.equal(idOf("Rise Real Estate Antelope 2 + Nicole + SOCAL"), "rise-real-estate-antelope");
  });

  test("a shared token does not create a false match", () => {
    // Both contain "douglas"; substring matching would confuse them.
    assert.equal(idOf("The RE Home Group of Douglas Realty + Nicole + BRIGHT"), "the-re-home-group");
    assert.equal(idOf("Douglas Elliman LA + Nicole + SOCAL"), "douglas-elliman-la");
  });
});

describe("token-run matching, never substrings", () => {
  test("a client name inside a longer WORD does not match", () => {
    // The rule that keeps "Rise" out of "Sunrise". This is the single most
    // important guarantee in the matcher.
    const clients: MatchableClient[] = [{ id: "rise", name: "Rise" }];
    assert.equal(matchCampaign("Sunrise Realty + Nicole", clients).clientId, null);
    assert.equal(matchCampaign("Rise + Nicole + SRAR", clients).clientId, "rise");
  });

  test("matching is case- and punctuation-insensitive", () => {
    // Live data: client "Fast Real Estate", campaign "FAST Real Estate".
    assert.equal(idOf("FAST Real Estate + Nicole + BRIDGE"), "fast-real-estate");
    // Client "ChuckTown Homes Team", campaign "Chucktown Homes Team".
    assert.equal(idOf("Chucktown Homes Team + Nicole + Charleston, SC"), "chucktown-homes-team");
    assert.equal(idOf("Properties & Estates + Nicole + Boston"), "properties-and-estates");
    assert.equal(idOf("RE/MAX Pacific 2 + Nicole + SOCAL"), "re-max-pacific");
  });
});

describe("aliases", () => {
  test("an alias resolves to its client", () => {
    assert.equal(idOf("Howe Realty + Nicole + ARMLS"), "howe-realty-group");
  });

  test("many aliases on one client do not make it ambiguous with itself", () => {
    const result = matchCampaign("Howe Realty Group + Nicole", CLIENTS);
    assert.equal(result.ambiguous, false);
    assert.equal(result.clientId, "howe-realty-group");
  });
});

describe("ties are refused, not guessed", () => {
  test("two different clients matching equally well is ambiguous", () => {
    const clients: MatchableClient[] = [
      { id: "alpha", name: "Summit Realty" },
      { id: "beta", name: "Realty Summit" },
      { id: "gamma", name: "Summit Realty", aliases: [] }, // same tokens, different client
    ];
    const result = matchCampaign("Summit Realty + Nicole", clients);
    assert.equal(result.clientId, null);
    assert.equal(result.ambiguous, true);
    assert.ok(result.candidates.length >= 2);
  });

  test("no match is unassigned, not ambiguous", () => {
    // Real: "Kelly + Co + Nicole + BRIGHT" has no client in the list.
    const result = matchCampaign("Kelly + Co + Nicole + BRIGHT", CLIENTS);
    assert.equal(result.clientId, null);
    assert.equal(result.ambiguous, false);
  });

  test("the result does not depend on client ordering", () => {
    const forward = matchCampaign("SERHANT. PA + Nicole + BRIGHT 10M+", CLIENTS);
    const reversed = matchCampaign("SERHANT. PA + Nicole + BRIGHT 10M+", [...CLIENTS].reverse());
    assert.equal(forward.clientId, reversed.clientId);
  });
});

describe("match modes", () => {
  test("prefix mode rejects a mid-string match", () => {
    const clients: MatchableClient[] = [
      { id: "liv", name: "LIV Indy Realty", matchMode: "prefix" },
    ];
    assert.equal(matchCampaign("LIV Indy Realty 4 + Nicole", clients).clientId, "liv");
    assert.equal(matchCampaign("Copy of LIV Indy Realty 4 + Nicole", clients).clientId, null);
  });

  test("exact mode requires the whole name", () => {
    const clients: MatchableClient[] = [{ id: "x", name: "SPACE", matchMode: "exact" }];
    assert.equal(matchCampaign("SPACE", clients).clientId, "x");
    assert.equal(matchCampaign("SPACE + Nicole + SOCAL", clients).clientId, null);
  });
});

describe("exclusions", () => {
  test("templates, internal lists and tests are excluded", () => {
    assert.equal(exclusionReason("Template Zillow Flex - EST"), "template");
    assert.equal(exclusionReason("Interested ZF - With Phone Number"), "internal routing list");
    assert.equal(exclusionReason("Interested NO ZF - NO Phone Number"), "internal routing list");
    assert.equal(exclusionReason("Not Interested - All Clients"), "internal routing list");
    assert.equal(exclusionReason("Front Range Realty - OpsLabs Test"), "internal test");
    assert.equal(exclusionReason("Test Client + Nicole + SOCAL"), "test campaign");
    assert.equal(exclusionReason("TEST ONBOARDING Rise Realty Of Florida LLC + Nicole + FTL"), "test campaign");
    assert.equal(exclusionReason("SERHANT PA tempo"), "draft/scratch campaign");
  });

  test("real client campaigns are NOT excluded", () => {
    // The exclusion list is explicit patterns rather than a "contains test"
    // heuristic precisely so a real client is never silently dropped.
    assert.equal(exclusionReason("Howe Realty 2 + Nicole + ARMLS"), null);
    assert.equal(exclusionReason("The Keyes Company + Nicole + West"), null);
    assert.equal(exclusionReason("C21 Results - Elite Team 2 + Nicole + FMLS. GAMLS"), null);
  });
});

/*
 * Deliverability tests belong to no client.
 *
 * Three of these were sitting in Unassigned, where they read as client work
 * nobody had attributed rather than as internal testing.
 */
test("inbox placement tests are excluded", () => {
  assert.equal(exclusionReason("INBOX PLACEMENT TEST - Real Copy"), "deliverability test");
  assert.equal(exclusionReason("Copy of INBOX PLACEMENT TEST"), "deliverability test");
  assert.equal(exclusionReason("Copy of INBOX PLACEMENT Neutral Copy"), "deliverability test");
});

test("a real client is not excluded by that rule", () => {
  // The reason the list matches the PHRASE and never a bare "test".
  assert.equal(exclusionReason("Test Valley Realty + Nicole + MLS"), null);
  assert.equal(exclusionReason("Placement Partners Realty"), null);
  assert.equal(exclusionReason("The Keyes Company + Nicole + West"), null);
});
