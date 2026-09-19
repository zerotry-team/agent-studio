import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export interface DescriptionItem {
  label: ReactNode;
  value: ReactNode;
  /** 2 列表示のとき、横幅いっぱいに表示する */
  wide?: boolean;
}

export function DescriptionList({ items, columns = 2, className }: { items: DescriptionItem[]; columns?: 1 | 2 | 3; className?: string }) {
  return (
    <dl
      className={cn(
        "grid gap-x-6 gap-y-4",
        columns === 2 && "sm:grid-cols-2",
        columns === 3 && "sm:grid-cols-2 lg:grid-cols-3",
        className,
      )}
    >
      {items.map((item, i) => (
        <div key={i} className={cn("min-w-0", item.wide && columns > 1 && "sm:col-span-full")}>
          <dt className="text-xs font-medium text-gray-500">{item.label}</dt>
          <dd className="mt-1 break-words text-sm text-gray-900">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
