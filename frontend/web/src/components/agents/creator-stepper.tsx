import { Check } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export interface StepperStep {
  label: string;
}

/** 手順の表示（今の手順に aria-current="step" を付ける） */
export function CreatorStepper({ steps, current }: { steps: readonly StepperStep[]; current: number }) {
  return (
    <nav aria-label="作成の手順" className="mb-6">
      <ol className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {steps.map((step, index) => {
          const number = index + 1;
          const done = number < current;
          const active = number === current;
          return (
            <li key={step.label} className="flex items-center gap-3" aria-current={active ? "step" : undefined}>
              {index > 0 ? <span className="hidden h-px w-8 bg-gray-300 sm:block" aria-hidden="true" /> : null}
              <span className="flex items-center gap-2">
                <span
                  className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                    active && "bg-accent-600 text-white",
                    done && "bg-accent-100 text-accent-700",
                    !active && !done && "border border-gray-300 bg-white text-gray-500",
                  )}
                  aria-hidden="true"
                >
                  {done ? <Check className="h-4 w-4" /> : number}
                </span>
                <span className={cn("text-sm", active ? "font-semibold text-gray-900" : "text-gray-500")}>
                  <span className="sr-only">
                    手順 {number}
                    {done ? "（完了）" : ""}:{" "}
                  </span>
                  {step.label}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
