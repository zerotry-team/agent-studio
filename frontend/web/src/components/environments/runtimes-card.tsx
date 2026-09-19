"use client";

import type { RuntimeDto } from "@agent-studio/contracts";
import { Server } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { QueryView } from "@/components/common/query-view";
import { RuntimeStatusBadge, StageBadge } from "@/components/common/status-badges";
import { TimeAgo } from "@/components/common/time-ago";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { TableSkeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type { ActionQuery } from "@/hooks/use-action-query";
import { PROVISIONING_TYPE_LABELS } from "@/lib/utils/labels";

export interface RuntimesCardProps {
  query: ActionQuery<RuntimeDto[]>;
  canManage: boolean;
  createAction: ReactNode;
}

/** Runtime（AWS の実行環境）の一覧 */
export function RuntimesCard({ query, canManage, createAction }: RuntimesCardProps) {
  return (
    <Card>
      <CardHeader
        title="Runtime（AWS の実行環境）"
        description="自社の AWS アカウント、または Agent Studio が用意する AWS で動く実行環境です。状態は自動で更新されます。"
      />
      <QueryView
        query={query}
        compactError
        loading={<TableSkeleton rows={2} columns={5} />}
        isEmpty={(items) => items.length === 0}
        empty={
          <EmptyState
            icon={Server}
            title="AWS の実行環境（Runtime）はまだありません"
            description={
              canManage
                ? "自社の AWS アカウントや、Agent Studio が用意する AWS で実行したい場合に作ります。OpenAI の環境だけを使う場合は必要ありません。"
                : "Runtime が作られると、ここに表示されます。"
            }
            action={createAction}
          />
        }
      >
        {(runtimes) => (
          <Table>
            <THead>
              <tr>
                <TH>名前</TH>
                <TH className="hidden md:table-cell">用意した人</TH>
                <TH>環境</TH>
                <TH>状態</TH>
                <TH className="hidden sm:table-cell">最終応答</TH>
                <TH className="hidden lg:table-cell">AWS アカウント</TH>
              </tr>
            </THead>
            <TBody>
              {runtimes.map((runtime) => (
                <TR key={runtime.id}>
                  <TD className="max-w-[14rem]">
                    <Link
                      href={`/runtimes/${runtime.id}`}
                      className="block truncate font-medium text-gray-900 hover:text-accent-700 hover:underline"
                    >
                      {runtime.name}
                    </Link>
                    <span className="block truncate text-xs text-gray-500 md:hidden">{PROVISIONING_TYPE_LABELS[runtime.provisioning_type]}</span>
                  </TD>
                  <TD className="hidden text-gray-600 md:table-cell">{PROVISIONING_TYPE_LABELS[runtime.provisioning_type]}</TD>
                  <TD>
                    <StageBadge stage={runtime.stage} />
                  </TD>
                  <TD>
                    <RuntimeStatusBadge status={runtime.status} />
                  </TD>
                  <TD className="hidden text-gray-500 sm:table-cell">
                    <TimeAgo value={runtime.last_heartbeat_at} fallback="なし" />
                  </TD>
                  <TD className="hidden font-mono text-xs text-gray-600 lg:table-cell">{runtime.aws_account_id}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </QueryView>
    </Card>
  );
}
