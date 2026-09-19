"use client";

import {
  Bot,
  ChartColumn,
  History,
  LayoutDashboard,
  Plug,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "@/hooks/use-session";
import { cn } from "@/lib/utils/cn";
import { visibleNavItems } from "@/lib/utils/permissions";

const ICONS: Record<string, LucideIcon> = {
  "/": LayoutDashboard,
  "/agents": Bot,
  "/runs": History,
  "/approvals": ShieldCheck,
  "/workflows": Workflow,
  "/tools": Wrench,
  "/connections": Plug,
  "/environments": Server,
  "/audit-logs": ScrollText,
  "/usage": ChartColumn,
  "/settings": Settings,
};

/** 別のパスでも、この項目を選択中として表示する */
const EXTRA_PREFIXES: Record<string, string[]> = {
  "/environments": ["/runtimes"],
};

export function isNavActive(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  const prefixes = [href, ...(EXTRA_PREFIXES[href] ?? [])];
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname() ?? "/";
  const { access, membership } = useSession();
  const items = membership ? visibleNavItems(access) : [];

  if (items.length === 0) return null;

  return (
    <nav aria-label="メインメニュー" className="space-y-0.5">
      {items.map((item) => {
        const Icon = ICONS[item.href] ?? LayoutDashboard;
        const active = isNavActive(item.href, pathname);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500",
              active ? "bg-accent-50 text-accent-700" : "text-gray-600 hover:bg-gray-100 hover:text-gray-900",
            )}
          >
            <Icon
              className={cn("h-[18px] w-[18px] shrink-0", active ? "text-accent-600" : "text-gray-400 group-hover:text-gray-500")}
              aria-hidden="true"
            />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
