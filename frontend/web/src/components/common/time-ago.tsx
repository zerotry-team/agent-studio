"use client";

import { useEffect, useState } from "react";
import { formatDateTime, formatRelative } from "@/lib/utils/format";

/** 「3分前」のような相対時刻。マウスを乗せると正確な日時を表示する */
export function TimeAgo({ value, fallback = "—" }: { value: string | null | undefined; fallback?: string }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!value) return <>{fallback}</>;
  return (
    <time dateTime={value} title={formatDateTime(value)} className="whitespace-nowrap">
      {now ? formatRelative(value, now) : formatDateTime(value)}
    </time>
  );
}
