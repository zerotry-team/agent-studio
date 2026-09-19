"use client";

import { Plus, Workflow } from "lucide-react";
import Link from "next/link";
import { listWorkflowsAction } from "@/actions/workflows";
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

export default function WorkflowsPage() {
  const { can, organization } = useSession();
  const canEdit = can("workflow.edit");
  const query = useActionQuery(() => listWorkflowsAction(), [organization?.id]);

  const createButton = canEdit ? (
    <ButtonLink href="/workflows/new" variant="primary" icon={<Plus className="h-4 w-4" aria-hidden="true" />}>
      ワークフローを作る
    </ButtonLink>
  ) : null;

  return (
    <>
      <PageHeader
        title="ワークフロー"
        description="複数のエージェントの実行と承認を、決めた順番で自動的に進めます。"
        actions={createButton}
      />
      <Card>
        <QueryView
          query={query}
          loading={<TableSkeleton rows={4} columns={4} />}
          compactError
          isEmpty={(items) => items.length === 0}
          empty={
            <EmptyState
              icon={Workflow}
              title="ワークフローはまだありません"
              description="複数のエージェントの実行と承認を順番につなげられます。前のエージェントの結果を、次のエージェントへの入力に使うこともできます。"
              action={createButton}
            />
          }
        >
          {(workflows) => (
            <Table>
              <THead>
                <tr>
                  <TH>名前</TH>
                  <TH className="hidden sm:table-cell">キー</TH>
                  <TH>バージョン</TH>
                  <TH>ステップ数</TH>
                  <TH className="hidden sm:table-cell">作成</TH>
                </tr>
              </THead>
              <TBody>
                {workflows.map((workflow) => (
                  <TR key={workflow.id}>
                    <TD className="max-w-[16rem]">
                      <Link
                        href={`/workflows/${workflow.id}`}
                        className="block truncate rounded font-medium text-gray-900 hover:text-accent-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                      >
                        {workflow.name}
                      </Link>
                      <span className="block truncate font-mono text-xs text-gray-500 sm:hidden">{workflow.key}</span>
                    </TD>
                    <TD className="hidden font-mono text-xs text-gray-600 sm:table-cell">{workflow.key}</TD>
                    <TD>
                      <Badge tone="neutral">v{workflow.version}</Badge>
                    </TD>
                    <TD className="text-gray-600">{workflow.definition.steps.length}</TD>
                    <TD className="hidden text-gray-500 sm:table-cell">
                      <TimeAgo value={workflow.created_at} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </QueryView>
      </Card>
    </>
  );
}
