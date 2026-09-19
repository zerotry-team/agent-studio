/** 「自動で更新しています」の表示（定期的に取り直している間に出す） */
export function LiveIndicator({ label = "自動で更新しています" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-accent-700">
      <span className="relative flex h-2 w-2" aria-hidden="true">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-accent-500" />
      </span>
      {label}
    </span>
  );
}
