"use client";

import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/*
 * The client filter on the Campaigns page, searchable.
 *
 * It was a <select> of fifty clients, which the browser renders as a scroll and
 * nothing else — finding "Norvell&Co" meant reading the list. Client feedback
 * asked for search, and the same Command/Popover the analytics filter bar uses
 * gives it for free, so the two controls behave identically.
 *
 * SINGLE SELECT, matching what the route accepts. MultiSelect exists next door
 * and was tempting to reuse, but `client_id` takes one value and pretending
 * otherwise in the UI would let someone choose three clients and see one.
 *
 * The three special choices sit above the roster because they are not clients:
 * everything, no client, and the campaigns deliberately kept out of client
 * reporting. Without the last one, seventeen campaigns are reachable by no
 * choice at all.
 */

export interface ClientOption {
  id: string;
  name: string;
}

export function ClientPicker({
  clients,
  value,
  onChange,
}: {
  clients: ClientOption[];
  /** "" = all · "unassigned" · "excluded" · a client id */
  value: string;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);

  const SPECIAL: ClientOption[] = [
    { id: "", name: "All clients" },
    { id: "unassigned", name: "Unassigned" },
    { id: "excluded", name: "Excluded from reporting" },
  ];

  const label =
    SPECIAL.find((s) => s.id === value)?.name ??
    clients.find((c) => c.id === value)?.name ??
    "All clients";

  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label="Filter by client"
          className={cn(
            "h-8 max-w-[200px] gap-1 px-2 text-xs font-normal",
            value && "text-foreground",
          )}
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput placeholder="Search clients…" className="h-9 text-xs" />
          <CommandList>
            <CommandEmpty className="py-6 text-center text-xs text-muted-foreground">
              No client matches that.
            </CommandEmpty>
            <CommandGroup>
              {SPECIAL.map((s) => (
                <CommandItem
                  key={s.id || "all"}
                  value={s.name}
                  onSelect={() => choose(s.id)}
                  className="gap-2 text-xs"
                >
                  <Check
                    className={cn("size-3", value === s.id ? "opacity-100" : "opacity-0")}
                  />
                  <span className="flex-1 truncate">{s.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup heading="Clients">
              {clients.map((c) => (
                <CommandItem
                  key={c.id}
                  value={c.name}
                  onSelect={() => choose(c.id)}
                  className="gap-2 text-xs"
                >
                  <Check
                    className={cn("size-3", value === c.id ? "opacity-100" : "opacity-0")}
                  />
                  <span className="flex-1 truncate">{c.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
