"use client";

import { Plus, Wrench } from "lucide-react";
import Link from "next/link";
import { listToolsAction } from "@/actions/tools";
import { PageHeader } from "@/components/common/page-header";
import { QueryView } from "@/components/common/query-view";
import { ToolRiskBadge } from "@/components/common/status-badges";
import { TimeAgo } from "@/components/common/time-ago";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { TableSkeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";
import { EXECUTION_LOCATION_LABELS } from "@/lib/utils/labels";

export default function ToolsPage() {
  const { organization, can } = useSession();
  const canEdit = can("tool.edit");
  const query = useActionQuery(() => listToolsAction(), [organization?.id]);

  const createButton = canEdit ? (
    <ButtonLink href="/tools/new" variant="primary" icon={<Plus className="h-4 w-4" aria-hidden="true" />}>
      ツールを登録
    </ButtonLink>
  ) : null;

  return (
    <>
      <PageHeader
        title="ツール"
        description="エージェントが使えるツール（外部への送信、公開サーバー、社内システムの呼び出しなど）の一覧です。ツールはバージョンごとに管理されます。"
        actions={createButton}
      />
      <QueryView
        query={query}
        loading={
          <Card>
            <TableSkeleton rows={5} columns={5} />
          </Card>
        }
        isEmpty={(tools) => tools.length === 0}
        empty={
          <Card>
            <EmptyState
              icon={Wrench}
              title="ツールはまだ登録されていません"
              description={
                canEdit
                  ? "エージェントに使わせたい操作をツールとして登録すると、エージェントの定義から呼び出せるようになります。"
                  : "ツールが登録されると、ここに表示されます。"
              }
              action={createButton}
            />
          </Card>
        }
      >
        {(tools) => (
          <Card>
            <Table>
              <THead>
                <tr>
                  <TH>表示名</TH>
                  <TH className="hidden sm:table-cell">動く場所</TH>
                  <TH>リスク</TH>
                  <TH>最新バージョン</TH>
                  <TH className="hidden md:table-cell">登録</TH>
                </tr>
              </THead>
              <TBody>
                {tools.map((tool) => (
                  <TR key={tool.id}>
                    <TD className="max-w-[18rem]">
                      <Link
                        href={`/tools/${tool.id}`}
                        className="block truncate font-medium text-gray-900 hover:text-accent-700 hover:underline"
                      >
                        {tool.display_name}
                      </Link>
                      <span className="block truncate font-mono text-xs text-gray-500">{tool.name}</span>
                    </TD>
                    <TD className="hidden text-gray-600 sm:table-cell">{EXECUTION_LOCATION_LABELS[tool.execution_location]}</TD>
                    <TD>
                      <ToolRiskBadge risk={tool.risk} />
                    </TD>
                    <TD>
                      <span className="font-mono text-gray-700">v{tool.latest_version}</span>
                    </TD>
                    <TD className="hidden text-gray-500 md:table-cell">
                      <TimeAgo value={tool.created_at} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Card>
        )}
      </QueryView>
    </>
  );
}
