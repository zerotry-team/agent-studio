import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import type { Tone } from "@/lib/utils/labels";

const tones: Record<Tone, string> = {
  neutral: "bg-gray-100 text-gray-700 ring-gray-200",
  info: "bg-sky-50 text-sky-700 ring-sky-200",
  success: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  warning: "bg-amber-50 text-amber-800 ring-amber-200",
  danger: "bg-red-50 text-red-700 ring-red-200",
  accent: "bg-accent-50 text-accent-700 ring-accent-200",
};

const dots: Record<Tone, string> = {
  neutral: "bg-gray-400",
  info: "bg-sky-500",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
  accent: "bg-accent-500",
};

export interface BadgeProps {
  tone?: Tone;
  children: ReactNode;
  /** 状態を表す丸印を付ける */
  dot?: boolean;
  /** 丸印を点滅させる（実行中など） */
  pulse?: boolean;
  className?: string;
}

export function Badge({ tone = "neutral", children, dot = false, pulse = false, className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        tones[tone],
        className,
      )}
    >
      {dot ? (
        <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
          {pulse ? <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-75", dots[tone])} /> : null}
          <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", dots[tone])} />
        </span>
      ) : null}
      {children}
    </span>
  );
}
