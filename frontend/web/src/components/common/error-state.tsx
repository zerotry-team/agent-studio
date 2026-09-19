"use client";

import { CircleAlert, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils/cn";

export interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
  /** カードの中などで小さく表示する */
  compact?: boolean;
}

export function ErrorState({ message, onRetry, retrying = false, className, compact = false }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center text-center",
        compact ? "gap-3 px-4 py-6" : "gap-4 rounded-xl border border-red-100 bg-white px-6 py-12 shadow-sm",
        className,
      )}
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-red-50 text-red-500" aria-hidden="true">
        <CircleAlert className="h-5 w-5" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-gray-900">読み込めませんでした</p>
        <p className="max-w-md text-sm leading-relaxed text-gray-500">{message}</p>
      </div>
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry} loading={retrying} icon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}>
          もう一度読み込む
        </Button>
      ) : null}
    </div>
  );
}
