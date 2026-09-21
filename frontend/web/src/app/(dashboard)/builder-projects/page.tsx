"use client";

import { Blocks, Plus } from "lucide-react";
import Link from "next/link";
import { listBuilderProjectsAction } from "@/actions/builder-projects";
import { BuilderProjectStatusBadge } from "@/components/builder-projects/status";
import { PageHeader } from "@/components/common/page-header";
import { QueryView } from "@/components/common/query-view";
import { TimeAgo } from "@/components/common/time-ago";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { TableSkeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";

export default function BuilderProjectsPage() {
  const { can, organization } = useSession();
  const query = useActionQuery(() => listBuilderProjectsAction(), [organization?.id], {
    refetchInterval: (projects) => projects?.some((project) => ["draft", "analyzing", "discovering"].includes(project.status)) ? 2_000 : false,
  });
  const create = can("builder.edit") ? (
    <ButtonLink href="/builder-projects/new" variant="primary" icon={<Plus className="h-4 w-4" aria-hidden="true" />}>作成を依頼</ButtonLink>
  ) : null;

  return (
    <>
      <PageHeader title="作成プロジェクト" description="業務の説明から、必要な連携・実装・テスト・Previewまでを一つの作業として進めます。" actions={create} />
      <Card>
        <QueryView query={query} loading={<TableSkeleton rows={4} columns={4} />} compactError isEmpty={(items) => items.length === 0}
          empty={<EmptyState icon={Blocks} title="作成プロジェクトはまだありません" description="実現したい業務と判断基準を説明すると、必要な能力と準備を整理します。" action={create} />}>
          {(projects) => (
            <Table>
              <THead><tr><TH>依頼</TH><TH>状態</TH><TH className="hidden sm:table-cell">不足能力</TH><TH className="hidden sm:table-cell">更新</TH></tr></THead>
              <TBody>{projects.map((project) => (
                <TR key={project.id}>
                  <TD className="max-w-xl"><Link href={`/builder-projects/${project.id}`} className="line-clamp-2 font-medium text-gray-900 hover:text-accent-700 hover:underline">{project.request}</Link></TD>
                  <TD><BuilderProjectStatusBadge status={project.status} /></TD>
                  <TD className="hidden text-gray-600 sm:table-cell">{project.gaps.filter((gap) => gap.status === "open").length}</TD>
                  <TD className="hidden text-gray-500 sm:table-cell"><TimeAgo value={project.updated_at} /></TD>
                </TR>
              ))}</TBody>
            </Table>
          )}
        </QueryView>
      </Card>
    </>
  );
}
