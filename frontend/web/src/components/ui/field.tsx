"use client";

import { createContext, useContext, useId, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

interface FieldContextValue {
  id: string;
  describedBy?: string;
  invalid: boolean;
  required: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/** Field の中の入力部品は、id と aria-describedby / aria-invalid を自動で受け取る */
export function useFieldContext(): FieldContextValue | null {
  return useContext(FieldContext);
}

export interface FieldProps {
  label: ReactNode;
  children: ReactNode;
  /** 補足の説明 */
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  /** 「任意」と表示する */
  optional?: boolean;
  className?: string;
  /** 指定しない場合は自動で作る */
  id?: string;
}

export function Field({ label, children, hint, error, required = false, optional = false, className, id }: FieldProps) {
  const autoId = useId();
  const fieldId = id ?? `field-${autoId}`;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <FieldContext.Provider value={{ id: fieldId, describedBy, invalid: !!error, required }}>
      <div className={cn("space-y-1.5", className)}>
        <label htmlFor={fieldId} className="flex items-center gap-2 text-sm font-medium text-gray-800">
          {label}
          {required ? (
            <span className="rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-600">必須</span>
          ) : optional ? (
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium text-gray-500">任意</span>
          ) : null}
        </label>
        {children}
        {hint ? (
          <p id={hintId} className="text-xs leading-relaxed text-gray-500">
            {hint}
          </p>
        ) : null}
        {error ? (
          <p id={errorId} className="text-xs font-medium text-red-600" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}

/** ラジオボタンやチェックボックスのまとまり（fieldset + legend） */
export function FieldSet({
  legend,
  description,
  error,
  children,
  className,
}: {
  legend: ReactNode;
  description?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <fieldset className={cn("space-y-3", className)}>
      <legend className="text-sm font-medium text-gray-800">{legend}</legend>
      {description ? <p className="-mt-1 text-xs leading-relaxed text-gray-500">{description}</p> : null}
      {children}
      {error ? (
        <p className="text-xs font-medium text-red-600" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
