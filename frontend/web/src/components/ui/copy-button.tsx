"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils/cn";

export interface CopyButtonProps {
  value: string;
  label?: string;
  className?: string;
  /** 暗い背景の上に置くとき */
  inverted?: boolean;
}

export function CopyButton({ value, label = "コピー", className, inverted = false }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // クリップボードが使えない環境では、選択して手動でコピーしてもらう
      window.prompt("コピーしてください", value);
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500",
        inverted
          ? "bg-white/10 text-gray-100 hover:bg-white/20"
          : "border border-gray-300 bg-white text-gray-700 shadow-sm hover:bg-gray-50",
        className,
      )}
    >
      {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
      <span aria-live="polite">{copied ? "コピーしました" : label}</span>
    </button>
  );
}
