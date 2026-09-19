"use client";

import { ChevronDown } from "lucide-react";
import {
  forwardRef,
  type AriaAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils/cn";
import { useFieldContext } from "./field";

const control =
  "block w-full rounded-lg border border-gray-300 bg-white text-sm text-gray-900 shadow-sm transition-colors " +
  "placeholder:text-gray-400 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/20 " +
  "disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500 read-only:bg-gray-50 " +
  "aria-[invalid=true]:border-red-400 aria-[invalid=true]:focus:ring-red-500/20";

function useControlProps(props: {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: AriaAttributes["aria-invalid"];
  required?: boolean;
}) {
  const field = useFieldContext();
  return {
    id: props.id ?? field?.id,
    "aria-describedby": props["aria-describedby"] ?? field?.describedBy,
    "aria-invalid": props["aria-invalid"] ?? (field?.invalid || undefined),
    required: props.required ?? (field?.required || undefined),
  };
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  const a11y = useControlProps(props);
  return <input ref={ref} className={cn(control, "h-10 px-3", className)} {...props} {...a11y} />;
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** 等幅フォント（YAML や JSON の編集用） */
  mono?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, mono = false, rows = 4, ...props },
  ref,
) {
  const a11y = useControlProps(props);
  return (
    <textarea
      ref={ref}
      rows={rows}
      spellCheck={mono ? false : props.spellCheck}
      className={cn(control, "px-3 py-2 leading-relaxed", mono && "font-mono text-[13px]", className)}
      {...props}
      {...a11y}
    />
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  children: ReactNode;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ className, children, ...props }, ref) {
  const a11y = useControlProps(props);
  return (
    <div className="relative">
      <select ref={ref} className={cn(control, "h-10 appearance-none pl-3 pr-9", className)} {...props} {...a11y}>
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
        aria-hidden="true"
      />
    </div>
  );
});

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: ReactNode;
  description?: ReactNode;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, description, className, ...props },
  ref,
) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-3", props.disabled && "cursor-not-allowed opacity-60", className)}>
      <input
        ref={ref}
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-gray-300 text-accent-600 accent-accent-600 focus:ring-2 focus:ring-accent-500"
        {...props}
      />
      <span className="text-sm">
        <span className="font-medium text-gray-800">{label}</span>
        {description ? <span className="mt-0.5 block text-xs leading-relaxed text-gray-500">{description}</span> : null}
      </span>
    </label>
  );
});
