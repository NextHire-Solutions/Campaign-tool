"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

/*
 * The four analytics tabs. Real routes, not client state, so each is
 * linkable and back/forward works.
 *
 * The current filter query string is carried across tab switches — changing
 * from Campaign to Attribution should not silently reset your date range.
 */

const TABS = [
  { href: "/analytics/campaign", label: "Campaign" },
  { href: "/analytics/volume", label: "Volume" },
  { href: "/analytics/infrastructure", label: "Infrastructure" },
  { href: "/analytics/attribution", label: "Attribution" },
  { href: "/analytics/copy-offer", label: "Copy & Offer" },
];

export function TabBar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const qs = searchParams.toString();

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b px-4">
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={qs ? `${tab.href}?${qs}` : tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative px-2.5 py-3 text-sm transition-colors",
              active
                ? "font-medium text-foreground after:absolute after:inset-x-2.5 after:bottom-0 after:h-0.5 after:bg-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
