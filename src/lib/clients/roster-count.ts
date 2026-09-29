/*
 * How many CLIENTS the roster holds — not how many rows.
 *
 * The business's rules (30 Sep), the same ones BrokerStaffer OS counts by:
 *   - Demo Portal backs the live demo client portal. It is kept, and it is
 *     never counted as a client.
 *   - A client with more than one portal has a row per portal here
 *     ("SERHANT. PA 15M+" beside "SERHANT. PA"). It counts once. A row is a
 *     second portal when its name is one of another row's aliases.
 *
 * Nothing is hidden: every row still lists. Only the count changes, and it
 * says which rows it left out.
 */

export interface RosterRow {
  id: string;
  name: string;
  aliases: string[];
  status: string;
}

const NON_CLIENTS = new Set(["demoportal"]);
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Why a row is not one more client, or null when it is one. */
export function notCounted(row: RosterRow, all: RosterRow[]): string | null {
  if (NON_CLIENTS.has(key(row.name))) return "not a client";
  const owner = all.find((o) => o.id !== row.id && o.aliases.some((a) => key(a) === key(row.name)));
  return owner ? `second portal of ${owner.name}` : null;
}

export function countRoster(all: RosterRow[]): { clients: number; active: number; inactive: number; left: { name: string; why: string }[] } {
  const left: { name: string; why: string }[] = [];
  let clients = 0, active = 0;
  for (const r of all) {
    const why = notCounted(r, all);
    if (why) { left.push({ name: r.name, why }); continue; }
    clients++;
    if (r.status === "active") active++;
  }
  return { clients, active, inactive: clients - active, left };
}
