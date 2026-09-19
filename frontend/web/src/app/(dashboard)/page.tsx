"use client";

import type { RuntimeStatus } from "@agent-studio/contracts";
import { Activity, ArrowRight, Bot, History, Server, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { getDashboardSummaryAction } from "@/actions/dashboard";
import { PageHeader } from "@/components/common/page-header";
import { QueryView } from "@/components/common/query-view";
import { RunStatusBadge, RuntimeStatusBadge, StageBadge } from "@/components/common/status-badges";
import { TimeAgo } from "@/components/common/time-ago";
import { StatCard } from "@/components/dashboard/stat-card";
import { Alert } from "@/components/ui/alert";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton, SkeletonGroup, TableSkeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";
import { PROFILE_TYPE_LABELS, PROVISIONING_TYPE_LABELS } from "@/lib/utils/labels";

const ACTIVE_RUN_STATUSES = new Set(["queued", "provisioning", "running", "waiting_approval", "requires_action"]);
const UNHEALTHY: RuntimeStatus[] = ["degraded", "offline"];

function DashboardSkeleton() {
  return (
    <SkeletonGroup>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-3 h-7 w-12" />
          </div>
        ))}
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm lg:col-span-2">
          <TableSkeleton rows={5} columns={4} />
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="mt-4 h-12 w-full" />
          <Skeleton className="mt-2 h-12 w-full" />
        </div>
      </div>
    </SkeletonGroup>
  );
}

export default function DashboardPage() {
  const { organization, can } = useSession();
  const query = useActionQuery(() => getDashboardSummaryAction(), [organization?.id], { refetchInterval: 30_000 });

  return (
    <>
      <PageHeader
        title="ダッシュボード"
        description={organization ? `${organization.name} のエージェントの実行状況と、実行環境の状態です。` : undefined}
        actions={
          can("agent.edit") ? (
            <ButtonLink href="/agents/new" variant="primary" icon={<Bot className="h-4 w-4" aria-hidden="true" />}>
              エージェントを作る
            </ButtonLink>
          ) : null
        }
      />
      <QueryView query={query} loading={<DashboardSkeleton />}>
        {(summary) => {
          const pendingCount = summary.pendingApprovals?.length ?? null;
          const runs = summary.recentRuns ?? [];
          const activeRuns = runs.filter((r) => ACTIVE_RUN_STATUSES.has(r.status)).length;
          const runtimes = summary.runtimes ?? [];
          const liveRuntimes = runtimes.filter((r) => r.status !== "revoked");
          const unhealthy = liveRuntimes.filter((r) => UNHEALTHY.includes(r.status));
          const connected = liveRuntimes.filter((r) => r.status === "active").length;
          const profiles = summary.profiles ?? [];

          return (
            <div className="space-y-6">
              {summary.warnings.length > 0 ? (
                <Alert tone="warning" title="一部の情報を読み込めませんでした">
                  {summary.warnings.join(" / ")}
                </Alert>
              ) : null}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <StatCard
                  label="承認待ち"
                  value={pendingCount ?? "—"}
                  icon={ShieldCheck}
                  href="/approvals"
                  highlight={pendingCount ? "warning" : null}
                  hint={pendingCount ? "内容を確認して、承認または却下してください" : "承認を待っている操作はありません"}
                />
                <StatCard
                  label="進行中の実行"
                  value={summary.recentRuns ? activeRuns : "—"}
                  icon={Activity}
                  href="/runs"
                  highlight={activeRuns > 0 ? "accent" : null}
                  hint="最近の実行のうち、終わっていないもの"
                />
                <StatCard
                  label="接続済みの Runtime"
                  value={summary.runtimes ? `${connected} / ${liveRuntimes.length}` : "—"}
                  icon={Server}
                  href="/environments"
                  highlight={unhealthy.length > 0 ? "danger" : null}
                  hint={unhealthy.length > 0 ? `${unhealthy.length} 件に問題があります` : "自社・専用の AWS で動く実行環境"}
                />
              </div>

              {unhealthy.length > 0 ? (
                <Alert tone="danger" title="応答していない実行環境があります">
                  {unhealthy.map((r) => r.name).join("、")} の状態を確認してください。{" "}
                  <Link href="/environments" className="font-medium underline">
                    実行環境を開く
                  </Link>
                </Alert>
              ) : null}

              <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                <Card className="lg:col-span-2">
                  <CardHeader
                    title="最近の実行"
                    actions={
                      <Link href="/runs" className="inline-flex items-center gap-1 text-sm font-medium text-accent-700 hover:underline">
                        すべて見る
                        <ArrowRight className="h-4 w-4" aria-hidden="true" />
                      </Link>
                    }
                  />
                  {summary.recentRuns === null ? (
                    <p className="px-5 py-8 text-center text-sm text-gray-500">実行履歴を読み込めませんでした</p>
                  ) : runs.length === 0 ? (
                    <EmptyState
                      icon={History}
                      title="まだ実行されていません"
                      description="エージェントをデプロイすると、ここから実行の様子を確認できます。"
                      action={
                        <ButtonLink href="/agents" variant="secondary" size="sm">
                          エージェントを見る
                        </ButtonLink>
                      }
                    />
                  ) : (
                    <Table>
                      <THead>
                        <tr>
                          <TH>エージェント</TH>
                          <TH>状態</TH>
                          <TH className="hidden sm:table-cell">実行環境</TH>
                          <TH>開始</TH>
                        </tr>
                      </THead>
                      <TBody>
                        {runs.map((run) => (
                          <TR key={run.id}>
                            <TD className="max-w-[14rem]">
                              <Link
                                href={`/runs/${run.id}`}
                                className="block truncate font-medium text-gray-900 hover:text-accent-700 hover:underline"
                              >
                                {run.agent.name}
                              </Link>
                              <span className="block truncate text-xs text-gray-500">{run.input}</span>
                            </TD>
                            <TD>
                              <RunStatusBadge status={run.status} />
                            </TD>
                            <TD className="hidden sm:table-cell">
                              <span className="flex items-center gap-2">
                                <span className="truncate text-gray-600">{run.runtime_profile.name}</span>
                                <StageBadge stage={run.deployment.stage} />
                              </span>
                            </TD>
                            <TD className="text-gray-500">
                              <TimeAgo value={run.created_at} />
                            </TD>
                          </TR>
                        ))}
                      </TBody>
                    </Table>
                  )}
                </Card>

                <Card>
                  <CardHeader
                    title="実行環境"
                    actions={
                      <Link href="/environments" className="inline-flex items-center gap-1 text-sm font-medium text-accent-700 hover:underline">
                        管理
                        <ArrowRight className="h-4 w-4" aria-hidden="true" />
                      </Link>
                    }
                  />
                  <div className="divide-y divide-gray-100">
                    {summary.runtimes === null ? (
                      <p className="px-5 py-8 text-center text-sm text-gray-500">実行環境の状態を読み込めませんでした</p>
                    ) : runtimes.length === 0 ? (
                      <p className="px-5 py-6 text-sm leading-relaxed text-gray-500">
                        AWS で動く実行環境はまだありません。OpenAI の環境だけで実行することもできます。
                      </p>
                    ) : (
                      runtimes.map((runtime) => (
                        <Link
                          key={runtime.id}
                          href={`/runtimes/${runtime.id}`}
                          className="flex items-start justify-between gap-3 px-5 py-3 hover:bg-gray-50 focus-visible:bg-gray-50 focus-visible:outline-none"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-gray-900">{runtime.name}</span>
                            <span className="block text-xs text-gray-500">
                              {PROVISIONING_TYPE_LABELS[runtime.provisioning_type]}・最終応答 <TimeAgo value={runtime.last_heartbeat_at} fallback="なし" />
                            </span>
                          </span>
                          <RuntimeStatusBadge status={runtime.status} />
                        </Link>
                      ))
                    )}
                    {summary.profiles && profiles.length > 0 ? (
                      <div className="px-5 py-3">
                        <p className="text-xs font-medium text-gray-500">実行環境の設定</p>
                        <ul className="mt-2 space-y-1">
                          {(["openai_hosted", "self_hosted", "none"] as const).map((type) => {
                            const count = profiles.filter((p) => p.type === type).length;
                            if (count === 0) return null;
                            return (
                              <li key={type} className="flex justify-between text-sm text-gray-700">
                                <span>{PROFILE_TYPE_LABELS[type]}</span>
                                <span className="font-medium">{count}</span>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                </Card>
              </div>
            </div>
          );
        }}
      </QueryView>
    </>
  );
}
