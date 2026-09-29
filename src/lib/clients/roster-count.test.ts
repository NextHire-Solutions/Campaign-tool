import assert from "node:assert/strict";
import { test } from "node:test";

import { countRoster, notCounted, type RosterRow } from "./roster-count.ts";

const row = (id: string, name: string, status = "active", aliases: string[] = []): RosterRow => ({ id, name, status, aliases });

test("Demo Portal and second portals are listed but not counted as clients", () => {
  const all = [
    row("1", "SERHANT. PA", "active", ["SERHANT. PA 15M+"]),
    row("2", "SERHANT. PA 15M+"),
    row("3", "Properties & Estates", "active", ["Properties & Estates Florida"]),
    row("4", "Properties & Estates Florida"),
    row("5", "Demo Portal"),
    row("6", "Cain Realty Group", "paused"),
    row("7", "EXR", "churned"),
  ];
  const c = countRoster(all);
  assert.deepEqual([c.clients, c.active, c.inactive], [4, 2, 2]);
  assert.deepEqual(c.left.map((l) => l.name), ["SERHANT. PA 15M+", "Properties & Estates Florida", "Demo Portal"]);
  assert.equal(notCounted(all[1], all), "second portal of SERHANT. PA");
  assert.equal(notCounted(all[4], all), "not a client");
  assert.equal(notCounted(all[0], all), null, "a client's own name among its aliases does not make it its own second row");
});
