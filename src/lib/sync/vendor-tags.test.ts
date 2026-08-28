import { test } from "node:test";
import assert from "node:assert/strict";
import { vendorFromTags } from "./vendor.ts";

/*
 * The vendor rule, pinned against the tag vocabulary actually observed on all
 * 1,496 inboxes (walked 2026-08-29). These cases are the reason the rule is the
 * `p.` namespace and not a list of vendor names.
 */

const sys = (name: string) => ({ id: 0, name, default: true });
const tag = (name: string) => ({ id: 0, name, default: false });

test("reads the vendor out of the p. namespace", () => {
  assert.equal(vendorFromTags([tag("p.Zapmail Google")]), "Zapmail");
  assert.equal(vendorFromTags([tag("p.Maildoso Custom")]), "Maildoso");
  assert.equal(vendorFromTags([tag("p.LeadGenJay Google")]), "LeadGenJay");
  assert.equal(vendorFromTags([tag("p.Cheapinboxes Google")]), "Cheapinboxes");
});

test("the same vendor on two connection types is ONE vendor", () => {
  // Mission Inbox ships 24 custom and 6 Google inboxes. Splitting them would
  // make one supplier look like two smaller ones.
  assert.equal(vendorFromTags([tag("p.Mission Inbox Custom")]), "Mission Inbox");
  assert.equal(vendorFromTags([tag("p.Mission Inbox Google")]), "Mission Inbox");
});

test("system tags are never mistaken for a vendor", () => {
  // These carry default:true and describe the connection, not the supplier.
  assert.equal(vendorFromTags([sys("Google"), sys("Custom Mail Server")]), null);
  assert.equal(vendorFromTags([sys("Interested")]), null);
});

test("pool tags are not vendors", () => {
  // 534 inboxes carry "Nicole Pool" AND a vendor tag; whoever runs an inbox is
  // a different question from who sold it.
  assert.equal(vendorFromTags([tag("Nicole Pool"), tag("BrokerStaffer")]), null);
  assert.equal(
    vendorFromTags([tag("Nicole Pool"), tag("LeadGenJay"), tag("p.LeadGenJay Google")]),
    "LeadGenJay",
  );
});

test("an untagged inbox returns null, never a guess", () => {
  assert.equal(vendorFromTags([]), null);
  assert.equal(vendorFromTags(undefined), null);
  // 3 live inboxes are in exactly this state; they must show as Untagged.
  assert.equal(vendorFromTags([sys("Google")]), null);
});

test("a vendor named after a connection type survives", () => {
  // The suffix is only stripped when something is left, so this cannot
  // collapse to an empty label.
  assert.equal(vendorFromTags([tag("p.Google")]), "Google");
  assert.equal(vendorFromTags([tag("p.Custom")]), "Custom");
});

test("a new vendor needs no code change", () => {
  // The whole point of matching the namespace rather than a list of names.
  assert.equal(vendorFromTags([tag("p.Inframail Google")]), "Inframail");
});
