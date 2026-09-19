"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  /** 件数など */
  badge?: ReactNode;
  hidden?: boolean;
}

export interface TabsProps<T extends string> {
  tabs: readonly TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** 読み上げ用の名前 */
  label: string;
  /** TabPanel と組み合わせるための接頭辞 */
  idPrefix?: string;
  className?: string;
}

export function tabPanelId(prefix: string, id: string) {
  return `${prefix}-panel-${id}`;
}
function tabId(prefix: string, id: string) {
  return `${prefix}-tab-${id}`;
}

/** タブ（←→ キーで移動できる）。表示する内容は TabPanel で囲む */
export function Tabs<T extends string>({ tabs, value, onChange, label, idPrefix = "tabs", className }: TabsProps<T>) {
  const visible = tabs.filter((t) => !t.hidden);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = visible.findIndex((t) => t.id === value);
    let next = index;
    if (e.key === "ArrowRight") next = (index + 1) % visible.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + visible.length) % visible.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = visible.length - 1;
    else return;
    e.preventDefault();
    const target = visible[next];
    if (target) {
      onChange(target.id);
      refs.current[target.id]?.focus();
    }
  };

  return (
    <div className={cn("relative -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0", className)}>
      <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex min-w-max gap-1 border-b border-gray-200">
        {visible.map((tab) => {
          const selected = tab.id === value;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                refs.current[tab.id] = el;
              }}
              id={tabId(idPrefix, tab.id)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={tabPanelId(idPrefix, tab.id)}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(tab.id)}
              className={cn(
                "-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500",
                selected
                  ? "border-accent-600 text-accent-700"
                  : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-800",
              )}
            >
              {tab.label}
              {tab.badge !== undefined && tab.badge !== null ? (
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-[11px] font-semibold",
                    selected ? "bg-accent-100 text-accent-700" : "bg-gray-100 text-gray-600",
                  )}
                >
                  {tab.badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function TabPanel({
  id,
  value,
  idPrefix = "tabs",
  children,
  className,
}: {
  id: string;
  value: string;
  idPrefix?: string;
  children: ReactNode;
  className?: string;
}) {
  if (id !== value) return null;
  return (
    <div
      role="tabpanel"
      id={tabPanelId(idPrefix, id)}
      aria-labelledby={tabId(idPrefix, id)}
      tabIndex={0}
      className={cn("pt-6 focus:outline-none", className)}
    >
      {children}
    </div>
  );
}
