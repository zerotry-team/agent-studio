"use client";

import { Bot, Plus } from "lucide-react";
import Link from "next/link";
import { listAgentsAction } from "@/actions/agents";
import { PageHeader } from "@/components/common/page-header";
import { QueryView } from "@/components/common/query-view";
import { TimeAgo } from "@/components/common/time-ago";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { TableSkeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";

export default function AgentsPage() {
  const { can, organization } = useSession();
  const canEdit = can("agent.edit");
  const query = useActionQuery(() => listAgentsAction(), [organization?.id]);

  const createButton = canEdit ? (
    <ButtonLink href="/agents/new" variant="primary" icon={<Plus className="h-4 w-4" aria-hidden="true" />}>
      エージェントを作る
    </ButtonLink>
  ) : null;

  return (
    <>
      <PageHeader
        title="エージェント"
        description="業務を任せるエージェントの一覧です。定義を公開してデプロイすると、実行できるようになります。"
        actions={createButton}
      />
      <Card>
        <QueryView
          query={query}
          compactError
          loading={<TableSkeleton rows={5} columns={5} />}
          isEmpty={(agents) => agents.length === 0}
          empty={
            <EmptyState
              icon={Bot}
              title="エージェントはまだありません"
              description={
                canEdit
                  ? "任せたい仕事を日本語で説明すると、AI がエージェントの定義を作ります。"
                  : "エージェントが作られると、ここに表示されます。"
              }
              action={createButton}
            />
          }
        >
          {(agents) => {
            const sorted = [...agents].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
            return (
              <Table>
                <THead>
                  <tr>
                    <TH>名前</TH>
                    <TH className="hidden md:table-cell">キー</TH>
                    <TH>公開中のバージョン</TH>
                    <TH className="hidden sm:table-cell">最新バージョン</TH>
                    <TH>更新</TH>
                  </tr>
                </THead>
                <TBody>
                  {sorted.map((agent) => (
                    <TR key={agent.id}>
                      <TD className="max-w-[18rem] sm:max-w-md">
                        <Link
                          href={`/agents/${agent.id}`}
                          className="block truncate font-medium text-gray-900 hover:text-accent-700 hover:underline"
                        >
                          {agent.name}
                        </Link>
                        {agent.description ? (
                          <span className="block truncate text-xs text-gray-500" title={agent.description}>
                            {agent.description}
                          </span>
                        ) : null}
                      </TD>
                      <TD className="hidden font-mono text-xs text-gray-600 md:table-cell">{agent.key}</TD>
                      <TD>
                        {agent.published_version !== null ? (
                          <Badge tone="success">v{agent.published_version} を公開中</Badge>
                        ) : (
                          <Badge tone="neutral">未公開</Badge>
                        )}
                      </TD>
                      <TD className="hidden tabular-nums text-gray-600 sm:table-cell">v{agent.latest_version}</TD>
                      <TD className="text-gray-500">
                        <TimeAgo value={agent.updated_at} />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            );
          }}
        </QueryView>
      </Card>
    </>
  );
}
