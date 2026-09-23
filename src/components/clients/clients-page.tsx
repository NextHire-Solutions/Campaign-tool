"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronRight, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ReplyGroupings } from "@/components/clients/reply-groupings";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { fullNumber } from "@/lib/analytics/format.ts";
import { SortableHeader } from "@/components/analytics/sortable-header";
import { sortRows, useTableSort } from "@/hooks/use-table-sort";
import { cn } from "@/lib/utils";

interface Client {
  id: string;
  name: string;
  slug: string;
  aliases: string[];
  matchMode: "contains" | "prefix" | "exact";
  status: "active" | "paused" | "churned" | "prospect";
  campaignCount: number;
  manualCount: number;
}

/*
 * Paused and churned clients are kept, never deleted — their campaigns and
 * history belong to them and a paused client comes back. But the list existed
 * to answer "who are our clients", and showing 53 rows for a roster of 35
 * answers it wrongly. So the list is the live roster by default and the rest
 * is one click away.
 */
const STATUS_STYLE: Record<Client["status"], string> = {
  active: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  paused: "bg-amber-50 text-amber-700 ring-amber-600/20",
  churned: "bg-muted text-muted-foreground ring-border",
  prospect: "bg-sky-50 text-sky-700 ring-sky-600/20",
};

interface Unassigned {
  campaignId: number;
  name: string;
  status: string | null;
  lifetimeSent: number;
  ambiguous: boolean;
}

interface Payload {
  clients: Client[];
  unassigned: Unassigned[];
  excludedCount: number;
}

export function ClientsPage() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Client | null>(null);
  const [creating, setCreating] = useState(false);
  const [showUnassigned, setShowUnassigned] = useState(true);
  const [showInactive, setShowInactive] = useState(false);

  const { data, isLoading } = useQuery<Payload>({
    queryKey: ["clients-admin"],
    queryFn: async () => {
      const r = await fetch("/api/clients");
      if (!r.ok) throw new Error("Failed to load clients");
      return r.json();
    },
  });

  const pin = useMutation({
    mutationFn: async ({ campaignId, clientId }: { campaignId: number; clientId: string | null }) => {
      const r = await fetch(`/api/campaigns/${campaignId}/client`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId }),
      });
      if (!r.ok) throw new Error("Failed to assign");
    },
    onSuccess: () => {
      toast.success("Campaign assigned");
      qc.invalidateQueries({ queryKey: ["clients-admin"] });
      // The rollups change too, so drop their caches rather than showing a
      // client list that disagrees with the analytics tabs.
      qc.invalidateQueries({ queryKey: ["clients"] });
      qc.invalidateQueries({ queryKey: ["campaigns"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/clients/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error("Failed to delete client");
    },
    onSuccess: () => {
      toast.success("Client deleted — its campaigns moved to Unassigned");
      qc.invalidateQueries({ queryKey: ["clients-admin"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Server order is lifetime volume; the third click restores it. Declared
  // above the loading return — a hook after an early return changes hook order
  // between renders.
  const { sort, toggle } = useTableSort();

  if (isLoading) return <Skeleton className="m-4 h-96" />;

  const all = data?.clients ?? [];
  const inactiveCount = all.filter((c) => c.status !== "active").length;
  const clients = sortRows(
    showInactive ? all : all.filter((c) => c.status === "active"),
    sort,
    (row, key) => (row as unknown as Record<string, unknown>)[key] ?? null,
  );
  const unassigned = data?.unassigned ?? [];

  return (
    <div className="flex-1 overflow-auto">
      <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
        <div>
          <h1 className="text-sm font-medium">Clients</h1>
          <p className="text-xs text-muted-foreground">
            {clients.length} {showInactive ? "clients" : "active clients"}
            {inactiveCount > 0 ? (
              <>
                {" · "}
                <button
                  type="button"
                  onClick={() => setShowInactive((v) => !v)}
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  {showInactive ? "hide" : "show"} {inactiveCount} paused/churned
                </button>
              </>
            ) : null}
            {" · "}
            {data?.excludedCount ?? 0} campaigns excluded from analytics
          </p>
        </div>
        <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => setCreating(true)}>
          <Plus className="size-3.5" />
          Add client
        </Button>
      </div>

      <div className="space-y-4 p-4">
        {/*
         * The unassigned queue. Collapsible and shown FIRST because it is the
         * only actionable thing on this page — everything else is reference.
         */}
        {unassigned.length > 0 ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50/40">
            <button
              type="button"
              onClick={() => setShowUnassigned((v) => !v)}
              className="flex w-full items-center gap-2 px-4 py-3 text-left"
            >
              <ChevronRight
                className={cn(
                  "size-4 shrink-0 text-amber-700 transition-transform",
                  showUnassigned && "rotate-90",
                )}
              />
              <AlertTriangle className="size-4 shrink-0 text-amber-600" />
              <span className="text-sm font-medium text-amber-900">
                {unassigned.length} campaign{unassigned.length === 1 ? "" : "s"} not
                assigned to a client
              </span>
              <span className="ml-auto tnum text-xs text-amber-700">
                {fullNumber(unassigned.reduce((t, u) => t + u.lifetimeSent, 0))} sent
              </span>
            </button>

            {showUnassigned ? (
              <div className="border-t border-amber-200">
                <p className="px-4 py-2 text-[11px] text-amber-800/80">
                  These still count toward workspace totals, in the Unassigned row of
                  the Clients view. Assigning here pins the single campaign — it does
                  not change matching rules for anything else.
                </p>
                <table className="w-full text-sm">
                  <tbody>
                    {unassigned.map((u) => (
                      <tr key={u.campaignId} className="border-t border-amber-200/60">
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-2">
                            <span className="truncate">{u.name}</span>
                            {u.ambiguous ? (
                              <span className="shrink-0 rounded bg-amber-200 px-1.5 py-0.5 text-[10px] text-amber-900">
                                matched 2+ clients
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td className="tnum whitespace-nowrap px-3 py-2 text-right text-xs text-muted-foreground">
                          {fullNumber(u.lifetimeSent)} sent
                        </td>
                        <td className="w-56 px-4 py-2">
                          <Select
                            onValueChange={(clientId) =>
                              pin.mutate({ campaignId: u.campaignId, clientId })
                            }
                          >
                            <SelectTrigger className="h-8 text-xs">
                              <SelectValue placeholder="Assign to client…" />
                            </SelectTrigger>
                            <SelectContent>
                              {/*
                                Every client, not the filtered view: a campaign
                                that ran for a client who has since paused or
                                churned still belongs to them, and hiding them
                                here would make it unassignable.
                              */}
                              {all.map((c) => (
                                <SelectItem key={c.id} value={c.id} className="text-xs">
                                  {c.name}
                                  {c.status !== "active" ? (
                                    <span className="ml-1 text-muted-foreground">({c.status})</span>
                                  ) : null}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30 text-[11px] uppercase tracking-wider text-muted-foreground">
                <SortableHeader label="Client" sortKey="name" align="left" sort={sort} onToggle={toggle} className="px-4 py-2" />
                <th className="px-3 py-2 text-left font-medium">Aliases</th>
                <SortableHeader label="Status" sortKey="status" align="left" sort={sort} onToggle={toggle} className="px-3 py-2" />
                <SortableHeader label="Match" sortKey="matchMode" align="left" sort={sort} onToggle={toggle} className="px-3 py-2" />
                <SortableHeader label="Campaigns" sortKey="campaignCount" sort={sort} onToggle={toggle} className="px-3 py-2" />
                <th className="w-24 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id} className="border-b last:border-b-0 hover:bg-accent/30">
                  <td className="px-4 py-2.5 font-medium">{c.name}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {c.aliases.length ? (
                        c.aliases.map((a) => (
                          <span
                            key={a}
                            className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                          >
                            {a}
                          </span>
                        ))
                      ) : (
                        <span className="text-xs text-muted-foreground/50">—</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[11px] font-medium capitalize ring-1 ring-inset",
                        STATUS_STYLE[c.status] ?? STATUS_STYLE.active,
                      )}
                    >
                      {c.status}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">
                    {c.matchMode}
                  </td>
                  <td className="tnum px-3 py-2.5 text-right">
                    {c.campaignCount}
                    {c.manualCount > 0 ? (
                      <span className="ml-1 text-[10px] text-muted-foreground">
                        ({c.manualCount} pinned)
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setEditing(c)}
                    >
                      Edit
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ClientDialog
        open={creating || editing !== null}
        client={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onDelete={editing ? () => remove.mutate(editing.id) : undefined}
      />
    </div>
  );
}

/** Create/edit dialog. Aliases are edited HERE — never from the unassigned queue. */
function ClientDialog({
  open,
  client,
  onClose,
  onDelete,
}: {
  open: boolean;
  client: Client | null;
  onClose: () => void;
  onDelete?: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState<string[]>([]);
  const [aliasDraft, setAliasDraft] = useState("");
  const [matchMode, setMatchMode] = useState<Client["matchMode"]>("contains");
  const [seeded, setSeeded] = useState<string | null>(null);

  // Seed from the client being edited, keyed on its id so switching rows
  // re-seeds without an effect.
  const key = client?.id ?? "new";
  if (open && seeded !== key) {
    setSeeded(key);
    setName(client?.name ?? "");
    setAliases(client?.aliases ?? []);
    setMatchMode(client?.matchMode ?? "contains");
    setAliasDraft("");
  }
  if (!open && seeded !== null) setSeeded(null);

  const save = useMutation({
    mutationFn: async () => {
      const body = JSON.stringify({ name, aliases, matchMode });
      const r = client
        ? await fetch(`/api/clients/${client.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body,
          })
        : await fetch("/api/clients", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error ?? "Failed to save");
      }
    },
    onSuccess: () => {
      toast.success(client ? "Client updated" : "Client created");
      qc.invalidateQueries({ queryKey: ["clients-admin"] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function addAlias() {
    const value = aliasDraft.trim();
    if (value && !aliases.includes(value)) setAliases([...aliases, value]);
    setAliasDraft("");
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {client ? "Edit client" : "Add client"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="client-name" className="text-xs">Name</Label>
            <Input
              id="client-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="The Keyes Company"
              className="h-8 text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Aliases</Label>
            <p className="text-[11px] text-muted-foreground">
              Other spellings that appear in campaign names. Matching uses the
              longest match, so a more specific alias wins over a shorter name.
            </p>
            <div className="flex flex-wrap gap-1">
              {aliases.map((a) => (
                <span
                  key={a}
                  className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px]"
                >
                  {a}
                  <button
                    type="button"
                    onClick={() => setAliases(aliases.filter((x) => x !== a))}
                    aria-label={`Remove ${a}`}
                  >
                    <X className="size-3 text-muted-foreground hover:text-foreground" />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-1.5">
              <Input
                value={aliasDraft}
                onChange={(e) => setAliasDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addAlias();
                  }
                }}
                placeholder="Add an alias…"
                className="h-8 text-xs"
              />
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={addAlias}>
                Add
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Match mode</Label>
            <Select value={matchMode} onValueChange={(v) => setMatchMode(v as Client["matchMode"])}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="contains" className="text-xs">
                  Contains — name appears anywhere
                </SelectItem>
                <SelectItem value="prefix" className="text-xs">
                  Prefix — campaign name starts with it
                </SelectItem>
                <SelectItem value="exact" className="text-xs">
                  Exact — whole name only
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Tighten this for short or generic names that would otherwise
              over-match.
            </p>
          </div>

          {/*
            §5.5: "These groupings are configurable per client." Only on an
            EXISTING client — a client being created has no id to attach an
            override to, and the defaults apply until it does.
          */}
          {client ? (
            <div className="border-t pt-4">
              <ReplyGroupings clientId={client.id} clientName={client.name} />
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {onDelete ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 text-xs text-destructive hover:text-destructive"
              onClick={() => {
                onDelete();
                onClose();
              }}
            >
              <Trash2 className="size-3.5" />
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-8 text-xs"
              disabled={!name.trim() || save.isPending}
              onClick={() => save.mutate()}
            >
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
