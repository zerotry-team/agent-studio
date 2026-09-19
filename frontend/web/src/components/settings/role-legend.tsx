import type { MemberRole } from "@agent-studio/contracts";
import { ChevronRight } from "lucide-react";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/lib/utils/labels";

const ROLES: readonly MemberRole[] = ["owner", "admin", "builder", "operator", "viewer"];

/** 「権限の違い」の説明（開閉できる） */
export function RoleLegend() {
  return (
    <details className="group rounded-lg border border-gray-200 bg-gray-50/60">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-4 py-3 text-sm font-medium text-gray-800 hover:bg-gray-100/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 text-gray-500 transition-transform group-open:rotate-90" aria-hidden="true" />
        権限の違い
      </summary>
      <dl className="space-y-3 px-4 pb-4 pt-1">
        {ROLES.map((role) => (
          <div key={role} className="sm:flex sm:gap-4">
            <dt className="shrink-0 text-sm font-medium text-gray-900 sm:w-24">{ROLE_LABELS[role]}</dt>
            <dd className="mt-0.5 text-sm leading-relaxed text-gray-600 sm:mt-0">{ROLE_DESCRIPTIONS[role]}</dd>
          </div>
        ))}
        <div className="border-t border-gray-200 pt-3 sm:flex sm:gap-4">
          <dt className="shrink-0 text-sm font-medium text-gray-900 sm:w-24">承認者</dt>
          <dd className="mt-0.5 text-sm leading-relaxed text-gray-600 sm:mt-0">
            権限とは別に付けられます。エージェントが承認の必要な操作をしようとしたとき、承認・却下できます。
          </dd>
        </div>
      </dl>
    </details>
  );
}
