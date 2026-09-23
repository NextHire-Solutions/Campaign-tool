"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Search, X } from "lucide-react";
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
 * Choose several campaigns to push a sequence into.
 *
 * Searching matches ANYWHERE in the name, not just the prefix — these campaigns
 * are named "<Client> + Nicole + <Market>", so the part that distinguishes them
 * is at the end, which is precisely where prefix matching and native select
 * type-ahead both give up.
 *
 * Selections stay visible as removable chips. "12 selected" would force you to
 * reopen the list to find out what you are about to write to.
 */

interface Campaign {
  /*
   * Text over the wire: /api/campaigns reads `campaigns_unified`, whose id
   * column holds an EmailBison bigint and an Instantly uuid in one column, so
   * even "297" arrives as a string. Normalised once below.
   */
  id: number | string;
  name: string;
  status: string;
  platform?: string;
}

export function CampaignMultiPicker({
  value,
  onChange,
  exclude,
}: {
  value: number[];
  onChange: (ids: number[]) => void;
  exclude?: number | null;
}) {
  const [open, setOpen] = useState(false);

  const { data } = useQuery<{ items: Campaign[] }>({
    queryKey: ["campaigns", "all", ""],
    queryFn: async () => {
      const response = await fetch("/api/campaigns?status=all");
      if (!response.ok) throw new Error("Failed to load campaigns");
      return response.json();
    },
    staleTime: 60_000,
  });

  /*
   * Both callers — Push sequence and Copy & Offer — work through EmailBison's
   * sequence API, which keys campaigns by bigint. An Instantly campaign has a
   * uuid and cannot be a target, so offering one offers a choice that fails.
   */
  const campaigns = (data?.items ?? [])
    .filter((c) => (c.platform ?? "emailbison") === "emailbison")
    .map((c) => ({ ...c, id: Number(c.id) }))
    .filter((c) => Number.isInteger(c.id) && c.id !== exclude);
  const chosen = campaigns.filter((c) => value.includes(c.id));

  function toggle(id: number) {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  }

  return (
    <div className="min-w-0 space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="h-9 w-full justify-between px-2.5 text-sm font-normal"
          >
            <span className={cn("truncate", !chosen.length && "text-muted-foreground")}>
              {chosen.length
                ? `${chosen.length} campaign${chosen.length === 1 ? "" : "s"} selected`
                : "Choose campaigns…"}
            </span>
            <ChevronsUpDown className="ml-2 size-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>

        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
          <Command
            filter={(v, search) => (v.toLowerCase().includes(search.toLowerCase()) ? 1 : 0)}
          >
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <CommandInput placeholder="Search campaigns…" className="h-9 pl-7 text-sm" />
            </div>
            <CommandList>
              <CommandEmpty className="py-6 text-center text-sm text-muted-foreground">
                No campaigns match
              </CommandEmpty>
              <CommandGroup>
                {campaigns.map((campaign) => (
                  <CommandItem
                    key={campaign.id}
                    value={campaign.name}
                    onSelect={() => toggle(campaign.id)}
                    className="gap-2 text-sm"
                  >
                    <span
                      className={cn(
                        "flex size-3.5 shrink-0 items-center justify-center rounded border",
                        value.includes(campaign.id)
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-input",
                      )}
                    >
                      {value.includes(campaign.id) ? <Check className="size-2.5" /> : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{campaign.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {campaign.status}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {chosen.length ? (
        <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
          {chosen.map((c) => (
            <span
              key={c.id}
              className="inline-flex max-w-full items-center gap-1 rounded border bg-muted/50 px-1.5 py-0.5 text-xs"
            >
              <span className="truncate">{c.name}</span>
              <button
                type="button"
                onClick={() => toggle(c.id)}
                aria-label={`Remove ${c.name}`}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
