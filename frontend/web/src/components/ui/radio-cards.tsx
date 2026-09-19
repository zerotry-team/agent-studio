"use client";

import type { LucideIcon } from "lucide-react";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export interface RadioCardOption<V extends string> {
  value: V;
  label: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  disabled?: boolean;
}

export interface RadioCardsProps<V extends string> {
  /** 質問の形の見出し（例:「どこで実行しますか？」） */
  legend: ReactNode;
  description?: ReactNode;
  options: readonly RadioCardOption<V>[];
  value: V | null;
  onChange: (value: V) => void;
  name?: string;
  columns?: 1 | 2 | 3;
  error?: string | null;
  className?: string;
}

/** 選択肢をカードで並べるラジオボタン（キーボードでも選べる） */
export function RadioCards<V extends string>({
  legend,
  description,
  options,
  value,
  onChange,
  name,
  columns = 1,
  error,
  className,
}: RadioCardsProps<V>) {
  const autoName = useId();
  const groupName = name ?? `radio-${autoName}`;
  return (
    <fieldset className={cn("space-y-3", className)}>
      <legend className="text-sm font-medium text-gray-800">{legend}</legend>
      {description ? <p className="-mt-1 text-xs leading-relaxed text-gray-500">{description}</p> : null}
      <div
        className={cn(
          "grid gap-3",
          columns === 2 && "sm:grid-cols-2",
          columns === 3 && "sm:grid-cols-2 lg:grid-cols-3",
        )}
      >
        {options.map((option) => {
          const selected = option.value === value;
          const Icon = option.icon;
          return (
            <label
              key={option.value}
              className={cn(
                "relative flex cursor-pointer gap-3 rounded-xl border bg-white p-4 shadow-sm transition-colors",
                "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent-500 has-[:focus-visible]:ring-offset-2",
                selected ? "border-accent-500 bg-accent-50/50 ring-1 ring-accent-500" : "border-gray-200 hover:border-gray-300",
                option.disabled && "cursor-not-allowed opacity-50",
              )}
            >
              <input
                type="radio"
                className="sr-only"
                name={groupName}
                value={option.value}
                checked={selected}
                disabled={option.disabled}
                onChange={() => onChange(option.value)}
              />
              {Icon ? (
                <span
                  className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                    selected ? "bg-accent-600 text-white" : "bg-gray-100 text-gray-600",
                  )}
                  aria-hidden="true"
                >
                  <Icon className="h-5 w-5" />
                </span>
              ) : (
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                    selected ? "border-accent-600" : "border-gray-300",
                  )}
                >
                  {selected ? <span className="h-2 w-2 rounded-full bg-accent-600" /> : null}
                </span>
              )}
              <span className="min-w-0">
                <span className="block text-sm font-medium text-gray-900">{option.label}</span>
                {option.description ? (
                  <span className="mt-1 block text-xs leading-relaxed text-gray-500">{option.description}</span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
      {error ? (
        <p className="text-xs font-medium text-red-600" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
