import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export interface StatCardProps {
  label: string;
  value: ReactNode;
  icon: LucideIcon;
  hint?: ReactNode;
  href?: string;
  /** 注意を引きたいとき（承認待ちがあるなど） */
  highlight?: "accent" | "warning" | "danger" | null;
}

export function StatCard({ label, value, icon: Icon, hint, href, highlight = null }: StatCardProps) {
  const body = (
    <div className="flex items-start gap-4">
      <span
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
          highlight === "accent" && "bg-accent-50 text-accent-600",
          highlight === "warning" && "bg-amber-50 text-amber-600",
          highlight === "danger" && "bg-red-50 text-red-600",
          !highlight && "bg-gray-100 text-gray-500",
        )}
        aria-hidden="true"
      >
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <p className="text-sm text-gray-500">{label}</p>
        <p className="mt-1 text-2xl font-semibold tracking-tight text-gray-900">{value}</p>
        {hint ? <p className="mt-1 text-xs text-gray-500">{hint}</p> : null}
      </div>
    </div>
  );
  const className = "block rounded-xl border border-gray-200 bg-white p-5 shadow-sm";
  if (!href) return <div className={className}>{body}</div>;
  return (
    <Link
      href={href}
      className={cn(
        className,
        "transition-colors hover:border-gray-300 hover:bg-gray-50/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500",
      )}
    >
      {body}
    </Link>
  );
}
