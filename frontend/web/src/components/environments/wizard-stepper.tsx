import { Check } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export interface WizardStepperProps {
  steps: readonly string[];
  /** 0 から始まる、いまの手順 */
  current: number;
  className?: string;
}

/** 手順の進み具合（1. 実行する場所 → 2. 設定 → 3. 確認） */
export function WizardStepper({ steps, current, className }: WizardStepperProps) {
  return (
    <nav aria-label="作成の手順" className={className}>
      <ol className="flex items-center gap-2 sm:gap-3">
        {steps.map((label, index) => {
          const done = index < current;
          const active = index === current;
          return (
            <li key={label} className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3" aria-current={active ? "step" : undefined}>
              <span
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                  done && "bg-accent-600 text-white",
                  active && "bg-accent-50 text-accent-700 ring-2 ring-accent-600",
                  !done && !active && "bg-gray-100 text-gray-500",
                )}
                aria-hidden="true"
              >
                {done ? <Check className="h-4 w-4" /> : index + 1}
              </span>
              <span
                className={cn(
                  "min-w-0 truncate text-xs sm:text-sm",
                  active ? "font-semibold text-gray-900" : done ? "font-medium text-gray-700" : "text-gray-500",
                )}
              >
                <span className="sr-only">
                  手順 {index + 1}
                  {done ? "（完了）" : active ? "（いまの手順）" : ""}:{" "}
                </span>
                {label}
              </span>
              {index < steps.length - 1 ? <span className="hidden h-px flex-1 bg-gray-200 sm:block" aria-hidden="true" /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
