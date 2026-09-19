"use client";

import { Building2, Check, ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { switchOrganizationAction } from "@/actions/auth";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { useSession } from "@/hooks/use-session";
import { cn } from "@/lib/utils/cn";
import { ROLE_LABELS } from "@/lib/utils/labels";

/** 組織の切り替え（所属が 1 つだけなら名前だけ表示する） */
export function OrgSwitcher() {
  const { me, organization } = useSession();
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (me.memberships.length === 0) return null;

  const switchTo = async (id: string) => {
    if (id === organization?.id) {
      setOpen(false);
      return;
    }
    setPendingId(id);
    const res = await switchOrganizationAction(id);
    setPendingId(null);
    setOpen(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    // 組織ごとにデータが違うため、ダッシュボードに戻る
    router.push("/");
    router.refresh();
  };

  const single = me.memberships.length === 1;

  return (
    <div ref={containerRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => !single && setOpen((v) => !v)}
        aria-haspopup={single ? undefined : "listbox"}
        aria-expanded={single ? undefined : open}
        aria-label={`操作中の組織: ${organization?.name ?? "未選択"}${single ? "" : "（切り替える）"}`}
        className={cn(
          "flex max-w-[16rem] items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm shadow-sm",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500",
          single ? "cursor-default" : "hover:bg-gray-50",
        )}
      >
        <Building2 className="h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
        <span className="truncate font-medium text-gray-800">{organization?.name ?? "組織を選択"}</span>
        {single ? null : <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />}
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label="組織を選ぶ"
          className="absolute left-0 z-40 mt-2 w-72 overflow-hidden rounded-xl border border-gray-200 bg-white py-1 shadow-lg"
        >
          <p className="px-3 pb-1 pt-2 text-xs font-medium text-gray-500">組織を切り替える</p>
          {me.memberships.map((m) => {
            const selected = m.organization.id === organization?.id;
            return (
              <button
                key={m.organization.id}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => switchTo(m.organization.id)}
                disabled={pendingId !== null}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-gray-50 focus-visible:bg-gray-50 focus-visible:outline-none disabled:opacity-60"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-gray-900">{m.organization.name}</span>
                  <span className="block text-xs text-gray-500">
                    {ROLE_LABELS[m.role]}
                    {m.is_approver ? "・承認者" : ""}
                  </span>
                </span>
                {pendingId === m.organization.id ? (
                  <Spinner className="h-4 w-4 text-gray-400" />
                ) : selected ? (
                  <Check className="h-4 w-4 text-accent-600" aria-hidden="true" />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
