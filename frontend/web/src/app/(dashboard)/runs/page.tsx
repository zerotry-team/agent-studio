"use client";

import type { DeploymentDto, RunDto } from "@agent-studio/contracts";
import { History, RefreshCw } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { listDeploymentsAction } from "@/actions/deployments";
import { listRunsAction } from "@/actions/runs";
import { PageHeader } from "@/components/common/page-header";
import { QueryView } from "@/components/common/query-view";
import { RunStatusBadge, StageBadge } from "@/components/common/status-badges";
import { TimeAgo } from "@/components/common/time-ago";
import { deploymentLabel } from "@/components/runs/deployment-label";
import { isTerminalRunStatus } from "@/components/runs/use-run-stream";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/input";
import { TableSkeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";
import { DEPLOYMENT_STATUS } from "@/lib/utils/labels";
import { formatDuration } from "@/lib/utils/format";

const PAGE_SIZE = 50;

function durationCell(run: RunDto) {
  if (!isTerminalRunStatus(run.status)) return <span className="text-gray-400">実行中</span>;
  return formatDuration(run.started_at ?? run.created_at, run.finished_at);
}

function DeploymentFilter({
  value,
  onChange,
  deployments,
}: {
  value: string;
  onChange: (value: string) => void;
  deployments: DeploymentDto[] | undefined;
}) {
  const active = deployments?.filter((d) => d.status === "active") ?? [];
  const past = deployments?.filter((d) => d.status !== "active") ?? [];
  const known = !value || deployments?.some((d) => d.id === value);
  return (
    <Field label="どのデプロイの実行を表示しますか？" className="w-full sm:max-w-md">
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">すべて</option>
        {!known ? <option value={value}>指定されたデプロイ</option> : null}
        {active.length > 0 ? (
          <optgroup label="稼働中のデプロイ">
            {active.map((d) => (
              <option key={d.id} value={d.id}>
                {deploymentLabel(d)}
              </option>
            ))}
          </optgroup>
        ) : null}
        {past.length > 0 ? (
          <optgroup label="以前のデプロイ">
            {past.map((d) => (
              <option key={d.id} value={d.id}>
                {deploymentLabel(d)}（{DEPLOYMENT_STATUS[d.status].label}）
              </option>
            ))}
          </optgroup>
        ) : null}
      </Select>
    </Field>
  );
}

function RunsTable({ runs }: { runs: RunDto[] }) {
  return (
    <Table>
      <THead>
        <tr>
          <TH>エージェント</TH>
          <TH>状態</TH>
          <TH className="hidden sm:table-cell">環境</TH>
          <TH className="hidden sm:table-cell">実行した人</TH>
          <TH>開始</TH>
          <TH>所要時間</TH>
        </tr>
      </THead>
      <TBody>
        {runs.map((run) => (
          <TR key={run.id}>
            <TD className="min-w-[12rem] max-w-[18rem]">
              <Link
                href={`/runs/${run.id}`}
                className="flex items-baseline gap-1.5 rounded font-medium text-gray-900 hover:text-accent-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
              >
                <span className="truncate">{run.agent.name}</span>
                <span className="shrink-0 text-xs font-normal text-gray-500">v{run.agent.version}</span>
              </Link>
              <span className="block truncate text-xs text-gray-500" title={run.input}>
                {run.input}
              </span>
            </TD>
            <TD>
              <RunStatusBadge status={run.status} />
            </TD>
            <TD className="hidden sm:table-cell">
              <span className="flex items-center gap-2">
                <span className="max-w-[10rem] truncate text-gray-600">{run.runtime_profile.name}</span>
                <StageBadge stage={run.deployment.stage} />
              </span>
            </TD>
            <TD className="hidden max-w-[12rem] truncate text-gray-600 sm:table-cell">{run.requested_by ?? "—"}</TD>
            <TD className="whitespace-nowrap text-gray-500">
              <TimeAgo value={run.started_at ?? run.created_at} />
            </TD>
            <TD className="whitespace-nowrap text-gray-600">{durationCell(run)}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

export default function RunsPage() {
  const { organization } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [deploymentId, setDeploymentId] = useState(() => searchParams.get("deployment_id") ?? "");
  /** 「さらに読み込む」で追加した分 */
  const [more, setMore] = useState<{ items: RunDto[]; hasMore: boolean } | null>(null);

  const deployments = useActionQuery(() => listDeploymentsAction(), [organization?.id]);
  const firstPage = useActionQuery(
    () => listRunsAction({ deployment_id: deploymentId || undefined, limit: PAGE_SIZE }),
    [organization?.id, deploymentId],
  );
  const loadMore = useActionMutation(listRunsAction);

  const changeFilter = (value: string) => {
    setDeploymentId(value);
    setMore(null);
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set("deployment_id", value);
    else params.delete("deployment_id");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const refresh = async () => {
    setMore(null);
    await firstPage.reload();
  };

  const runs = firstPage.data ? mergeRuns(firstPage.data, more?.items ?? []) : [];
  const hasMore = more ? more.hasMore : (firstPage.data?.length ?? 0) >= PAGE_SIZE;

  const fetchMore = async () => {
    const last = runs[runs.length - 1];
    if (!last) return;
    const res = await loadMore.mutate({ deployment_id: deploymentId || undefined, limit: PAGE_SIZE, before: last.created_at });
    if (res.ok) {
      setMore((prev) => ({ items: [...(prev?.items ?? []), ...res.data], hasMore: res.data.length >= PAGE_SIZE }));
    }
  };

  return (
    <>
      <PageHeader
        title="実行履歴"
        description="エージェントの実行の一覧です。行を開くと、経過や結果を確認できます。"
        actions={
          <Button
            variant="secondary"
            onClick={refresh}
            loading={firstPage.refreshing}
            icon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}
          >
            更新
          </Button>
        }
      />

      <div className="mb-4">
        <DeploymentFilter value={deploymentId} onChange={changeFilter} deployments={deployments.data} />
        {deployments.error ? (
          <p className="mt-1.5 text-xs text-gray-500">デプロイの一覧を読み込めなかったため、絞り込みは使えません。</p>
        ) : null}
      </div>

      <Card>
        <QueryView
          query={firstPage}
          loading={<TableSkeleton rows={6} columns={5} />}
          compactError
          isEmpty={(items) => items.length === 0}
          empty={
            <EmptyState
              icon={History}
              title={deploymentId ? "このデプロイの実行はまだありません" : "まだ実行されていません"}
              description={
                deploymentId
                  ? "ほかのデプロイを選ぶか、「すべて」に切り替えてください。"
                  : "エージェントをデプロイして実行すると、ここに履歴が表示されます。"
              }
              action={
                deploymentId ? (
                  <Button variant="secondary" size="sm" onClick={() => changeFilter("")}>
                    すべての実行を表示
                  </Button>
                ) : (
                  <ButtonLink href="/agents" size="sm">
                    エージェントを見る
                  </ButtonLink>
                )
              }
            />
          }
        >
          {() => (
            <>
              <RunsTable runs={runs} />
              {hasMore ? (
                <div className="flex justify-center border-t border-gray-100 px-5 py-4">
                  <Button variant="secondary" onClick={fetchMore} loading={loadMore.pending}>
                    さらに読み込む
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </QueryView>
      </Card>
    </>
  );
}

/** 追加で読み込んだ分をつなげる（同じ実行が重なった場合は 1 件にする） */
function mergeRuns(first: RunDto[], extra: RunDto[]): RunDto[] {
  if (extra.length === 0) return first;
  const seen = new Set(first.map((r) => r.id));
  return [...first, ...extra.filter((r) => !seen.has(r.id))];
}
