"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** 読み上げ用のラベル（見えるラベルが別にある場合も指定する） */
  label: string;
  /** 見えるラベル（省略時は表示しない） */
  children?: ReactNode;
  disabled?: boolean;
  className?: string;
}

export function Switch({ checked, onChange, label, children, disabled, className }: SwitchProps) {
  return (
    <label className={cn("inline-flex items-center gap-3", disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer", className)}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2",
          checked ? "bg-accent-600" : "bg-gray-300",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform",
            checked ? "translate-x-5" : "translate-x-0.5",
          )}
        />
      </button>
      {children ? <span className="text-sm text-gray-800">{children}</span> : null}
    </label>
  );
}
