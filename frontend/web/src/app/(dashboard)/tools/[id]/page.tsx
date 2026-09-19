"use client";

import type { ConnectionDto, ToolDto } from "@agent-studio/contracts";
import { ChevronRight, Plus } from "lucide-react";
import { useState } from "react";
import { listConnectionsAction } from "@/actions/connections";
import { getToolAction } from "@/actions/tools";
import { PageHeader } from "@/components/common/page-header";
import { QueryView } from "@/components/common/query-view";
import { ToolRiskBadge } from "@/components/common/status-badges";
import { TimeAgo } from "@/components/common/time-ago";
import { AddToolVersionDialog } from "@/components/tools/add-tool-version-dialog";
import { ToolSpecDetails } from "@/components/tools/tool-spec-details";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { JsonView } from "@/components/ui/code-block";
import { CopyButton } from "@/components/ui/copy-button";
import { Skeleton, SkeletonGroup, SkeletonText } from "@/components/ui/skeleton";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";
import { EXECUTION_LOCATION_LABELS } from "@/lib/utils/labels";

const BACK = { href: "/tools", label: "ツールの一覧" };

function ToolDetailSkeleton() {
  return (
    <SkeletonGroup>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm lg:col-span-2">
          <Skeleton className="h-5 w-40" />
          <SkeletonText className="mt-5" lines={5} />
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <Skeleton className="h-5 w-32" />
          <SkeletonText className="mt-5" lines={3} />
        </div>
      </div>
    </SkeletonGroup>
  );
}

export default function ToolDetailPage({ params }: { params: { id: string } }) {
  const { organization } = useSession();
  const query = useActionQuery(() => getToolAction(params.id), [organization?.id, params.id]);
  const connections = useActionQuery(() => listConnectionsAction(), [organization?.id]);

  return (
    <>
      {query.data === undefined ? <PageHeader title="ツールの詳細" back={BACK} /> : null}
      <QueryView query={query} loading={<ToolDetailSkeleton />}>
        {(tool) => <ToolDetail tool={tool} connections={connections.data} onChanged={query.reload} />}
      </QueryView>
    </>
  );
}

function ToolDetail({
  tool,
  connections,
  onChanged,
}: {
  tool: ToolDto;
  connections: ConnectionDto[] | undefined;
  onChanged: () => Promise<void>;
}) {
  const { can } = useSession();
  const [adding, setAdding] = useState(false);
  const versions = [...(tool.versions ?? [])].sort((a, b) => b.version - a.version);
  const latest = versions.find((v) => v.version === tool.latest_version) ?? versions[0] ?? null;

  return (
    <>
      <PageHeader
        back={BACK}
        title={tool.display_name}
        meta={<ToolRiskBadge risk={tool.risk} />}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <code className="font-mono text-gray-700">{tool.name}</code>
            <span aria-hidden="true" className="text-gray-300">
              |
            </span>
            <span>{EXECUTION_LOCATION_LABELS[tool.execution_location]}</span>
            <span aria-hidden="true" className="text-gray-300">
              |
            </span>
            <span>
              登録 <TimeAgo value={tool.created_at} />
            </span>
          </span>
        }
        actions={
          can("tool.edit") ? (
            <Button icon={<Plus className="h-4 w-4" aria-hidden="true" />} onClick={() => setAdding(true)}>
              新しいバージョンを追加
            </Button>
          ) : null
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title={`現在の設定（バージョン ${tool.latest_version}）`}
            description="バージョンを指定していないエージェントを次にデプロイするときに使われる、最新の内容です。"
          />
          <CardBody>
            {latest ? (
              <ToolSpecDetails spec={latest.spec} connections={connections} />
            ) : (
              <p className="text-sm text-gray-500">バージョンの情報を読み込めませんでした。</p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="エージェントからの使い方" />
          <CardBody className="space-y-4 text-sm leading-relaxed text-gray-600">
            <p>エージェントの定義（tools）に、次のどちらかの形で書きます。</p>
            <ReferenceExample value={tool.name} note="最新のバージョンを使います（デプロイした時点のもの）" />
            <ReferenceExample
              value={`${tool.name}@${tool.latest_version}`}
              note={`バージョン ${tool.latest_version} に固定します。新しいバージョンを追加しても変わりません`}
            />
          </CardBody>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader
          title="バージョンの履歴"
          description={`全 ${versions.length} 件。バージョンを指定しているエージェントは、指定したバージョンを使い続けます。`}
        />
        {versions.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-gray-500">バージョンがありません。</p>
        ) : (
          <ol className="divide-y divide-gray-100">
            {versions.map((version) => (
              <li key={version.id} className="px-5 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-gray-900">v{version.version}</span>
                  {version.version === tool.latest_version ? <Badge tone="accent">最新</Badge> : null}
                  <ToolRiskBadge risk={version.spec.risk} />
                  <span className="text-xs text-gray-500">
                    <TimeAgo value={version.created_at} />
                  </span>
                </div>
                <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-sm text-gray-700">{version.spec.description}</p>
                <details className="group mt-2">
                  <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded text-sm font-medium text-accent-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 [&::-webkit-details-marker]:hidden">
                    <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" aria-hidden="true" />
                    設定の内容（JSON）
                  </summary>
                  <JsonView value={version.spec} className="mt-2" maxHeight="20rem" />
                </details>
              </li>
            ))}
          </ol>
        )}
      </Card>

      {adding ? (
        <AddToolVersionDialog
          tool={tool}
          latestSpec={latest?.spec ?? null}
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            void onChanged();
          }}
        />
      ) : null}
    </>
  );
}

function ReferenceExample({ value, note }: { value: string; note: string }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 bg-gray-50 py-1 pl-3 pr-1">
        <code className="min-w-0 truncate font-mono text-[13px] text-gray-900">{value}</code>
        <CopyButton value={value} />
      </div>
      <p className="mt-1 text-xs text-gray-500">{note}</p>
    </div>
  );
}
