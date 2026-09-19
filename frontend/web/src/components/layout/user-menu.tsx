"use client";

import { Building2, ChevronDown, LogOut } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useSession } from "@/hooks/use-session";
import { cn } from "@/lib/utils/cn";
import { ROLE_LABELS } from "@/lib/utils/labels";

export function UserMenu() {
  const { me, membership, access } = useSession();
  const [open, setOpen] = useState(false);
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

  const name = me.user.display_name || me.user.email;
  const initial = name.trim().charAt(0).toUpperCase() || "?";

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="ユーザーメニュー"
        className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
      >
        <span
          className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-100 text-sm font-semibold text-accent-700"
          aria-hidden="true"
        >
          {initial}
        </span>
        <span className="hidden max-w-[10rem] truncate text-sm font-medium text-gray-700 md:block">{name}</span>
        <ChevronDown className="hidden h-4 w-4 text-gray-400 md:block" aria-hidden="true" />
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 z-40 mt-2 w-64 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg">
          <div className="border-b border-gray-100 px-4 py-3">
            <p className="truncate text-sm font-medium text-gray-900">{name}</p>
            <p className="truncate text-xs text-gray-500">{me.user.email}</p>
            {membership ? (
              <p className="mt-1 text-xs text-gray-500">
                {ROLE_LABELS[membership.role]}
                {membership.is_approver ? "・承認者" : ""}
              </p>
            ) : null}
          </div>
          <div className="py-1">
            {access.isPlatformAdmin ? (
              <Link
                role="menuitem"
                href="/admin/organizations/new"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 focus-visible:bg-gray-50 focus-visible:outline-none"
              >
                <Building2 className="h-4 w-4 text-gray-400" aria-hidden="true" />
                組織を作成（運営管理者）
              </Link>
            ) : null}
            {/* ログアウトは画面遷移で行う（Cognito のログアウト画面へリダイレクトするため） */}
            <a
              role="menuitem"
              href="/auth/logout"
              className={cn(
                "flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 focus-visible:bg-gray-50 focus-visible:outline-none",
              )}
            >
              <LogOut className="h-4 w-4 text-gray-400" aria-hidden="true" />
              ログアウト
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}
