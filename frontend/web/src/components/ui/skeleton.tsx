import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-gray-200/70", className)} aria-hidden="true" />;
}

/** 読み込み中の表示（読み上げ用に「読み込み中」を伝える） */
export function SkeletonGroup({ children, label = "読み込み中" }: { children: ReactNode; label?: string }) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("space-y-2", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn("h-4", i === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <SkeletonGroup>
      <div className="divide-y divide-gray-100">
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="flex items-center gap-4 px-4 py-3.5">
            {Array.from({ length: columns }, (_, c) => (
              <Skeleton key={c} className={cn("h-4", c === 0 ? "w-1/3" : "w-1/6")} />
            ))}
          </div>
        ))}
      </div>
    </SkeletonGroup>
  );
}

export function CardSkeleton({ className }: { className?: string }) {
  return (
    <SkeletonGroup>
      <div className={cn("rounded-xl border border-gray-200 bg-white p-5 shadow-sm", className)}>
        <Skeleton className="h-5 w-1/3" />
        <SkeletonText className="mt-4" lines={3} />
      </div>
    </SkeletonGroup>
  );
}
