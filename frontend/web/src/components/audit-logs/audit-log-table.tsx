"use client";

import type { AuditLogDto } from "@agent-studio/contracts";
import { ChevronRight } from "lucide-react";
import { Fragment, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { JsonView } from "@/components/ui/code-block";
import { CopyButton } from "@/components/ui/copy-button";
import { DescriptionList } from "@/components/ui/description-list";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { cn } from "@/lib/utils/cn";
import { formatDateTime, shortId } from "@/lib/utils/format";
import { ACTOR_TYPE_LABELS, AUDIT_RESULT } from "@/lib/utils/labels";

const COLUMN_COUNT = 6;

function actorName(log: AuditLogDto): string {
  return log.actor_label ?? shortId(log.actor_id);
}

function IdValue({ value, label }: { value: string | null; label: string }) {
  if (!value) return <span className="text-gray-400">なし</span>;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="break-all font-mono text-[12.5px]">{value}</span>
      <CopyButton value={value} label={`${label}をコピー`} />
    </span>
  );
}

function hasDetail(detail: unknown): boolean {
  if (detail === null || detail === undefined) return false;
  if (typeof detail === "string") return detail.trim() !== "";
  if (typeof detail === "object") return Object.keys(detail as object).length > 0;
  return true;
}

function AuditLogDetail({ log }: { log: AuditLogDto }) {
  return (
    <div className="space-y-4">
      <DescriptionList
        columns={2}
        items={[
          {
            label: "日時",
            value: (
              <span>
                {formatDateTime(log.created_at)}
                <span className="mt-0.5 block font-mono text-xs text-gray-500">{log.created_at}</span>
              </span>
            ),
          },
          {
            label: "実行者",
            value: (
              <span>
                {ACTOR_TYPE_LABELS[log.actor_type]}
                {log.actor_label ? `：${log.actor_label}` : ""}
              </span>
            ),
          },
          { label: "実行者の ID", value: <IdValue value={log.actor_id} label="実行者の ID " /> },
          { label: "対象の種類", value: log.target_type ?? <span className="text-gray-400">なし</span> },
          { label: "対象の ID", value: <IdValue value={log.target_id} label="対象の ID " /> },
          { label: "接続元", value: log.source_ip ? <span className="font-mono text-[12.5px]">{log.source_ip}</span> : <span className="text-gray-400">不明</span> },
          { label: "記録の ID", value: <IdValue value={log.id} label="記録の ID " />, wide: true },
        ]}
      />
      <div>
        <p className="text-xs font-medium text-gray-500">詳細</p>
        {hasDetail(log.detail) ? (
          <JsonView value={log.detail} className="mt-1" maxHeight="20rem" />
        ) : (
          <p className="mt-1 text-sm text-gray-500">詳細な情報は記録されていません。</p>
        )}
      </div>
    </div>
  );
}

/** 監査ログの表。行を開くと詳細（detail）と ID をすべて表示する */
export function AuditLogTable({ items }: { items: readonly AuditLogDto[] }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Table>
      <THead>
        <tr>
          <TH>日時</TH>
          <TH>実行者</TH>
          <TH>操作</TH>
          <TH className="hidden md:table-cell">対象</TH>
          <TH>結果</TH>
          <TH className="hidden lg:table-cell">接続元</TH>
        </tr>
      </THead>
      <TBody>
        {items.map((log) => {
          const open = expanded.has(log.id);
          const detailId = `audit-log-detail-${log.id}`;
          const result = AUDIT_RESULT[log.result];
          return (
            <Fragment key={log.id}>
              <TR className={cn(open && "bg-gray-50/80")}>
                <TD className="whitespace-nowrap">
                  <button
                    type="button"
                    onClick={() => toggle(log.id)}
                    aria-expanded={open}
                    aria-controls={detailId}
                    className="-ml-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-gray-800 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                  >
                    <ChevronRight
                      className={cn("h-4 w-4 shrink-0 text-gray-400 transition-transform", open && "rotate-90")}
                      aria-hidden="true"
                    />
                    <span>{formatDateTime(log.created_at)}</span>
                    <span className="sr-only">{open ? "の詳細を閉じる" : "の詳細を開く"}</span>
                  </button>
                </TD>
                <TD className="max-w-[14rem]">
                  <span className="block text-xs text-gray-500">{ACTOR_TYPE_LABELS[log.actor_type]}</span>
                  <span className="block truncate text-gray-800" title={log.actor_label ?? log.actor_id ?? undefined}>
                    {actorName(log)}
                  </span>
                </TD>
                <TD>
                  <span className="whitespace-nowrap font-mono text-[12.5px] text-gray-900">{log.action}</span>
                </TD>
                <TD className="hidden md:table-cell">
                  {log.target_type || log.target_id ? (
                    <span className="whitespace-nowrap text-gray-700">
                      {log.target_type ?? "—"}
                      {log.target_id ? <span className="ml-1.5 font-mono text-xs text-gray-500">{shortId(log.target_id)}</span> : null}
                    </span>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </TD>
                <TD>
                  <Badge tone={result.tone} dot>
                    {result.label}
                  </Badge>
                </TD>
                <TD className="hidden whitespace-nowrap font-mono text-xs text-gray-500 lg:table-cell">{log.source_ip ?? "—"}</TD>
              </TR>
              {open ? (
                <tr id={detailId} className="bg-gray-50/80">
                  <td colSpan={COLUMN_COUNT} className="px-4 pb-5 pt-1 sm:px-6">
                    <AuditLogDetail log={log} />
                  </td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </TBody>
    </Table>
  );
}
