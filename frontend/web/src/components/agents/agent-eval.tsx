"use client";

import type { AgentDto, DeploymentDto, EvalCaseDto, EvalRunDto } from "@agent-studio/contracts";
import { ExternalLink, FlaskConical, ListChecks, Play, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { deleteEvalCaseAction, listEvalCasesAction, listEvalRunsAction, startEvalRunAction } from "@/actions/evals";
import { ErrorState } from "@/components/common/error-state";
import { QueryView } from "@/components/common/query-view";
import { EvalResultStatusBadge, EvalRunStatusBadge } from "@/components/common/status-badges";
import { TimeAgo } from "@/components/common/time-ago";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { CardSkeleton, Skeleton, SkeletonGroup, TableSkeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { useActionQuery, type ActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";
import { cn } from "@/lib/utils/cn";
import { activeDeployments, deploymentLabel, DeploymentSelect, type AgentTab } from "./deployment-select";
import { EvalCaseDialog } from "./eval-case-dialog";

const RUNS_PAGE = 5;

export interface AgentEvalProps {
  agent: AgentDto;
  deployments: ActionQuery<DeploymentDto[]>;
  onGoToTab: (tab: AgentTab) => void;
}

export function AgentEval({ agent, deployments, onGoToTab }: AgentEvalProps) {
  const { can, organization } = useSession();
  const canEdit = can("eval.edit");
  const cases = useActionQuery(() => listEvalCasesAction(agent.id), [agent.id, organization?.id]);
  const runs = useActionQuery(() => listEvalRunsAction(agent.id), [agent.id, organization?.id], {
    refetchInterval: (data) => (data?.some((r) => r.status === "running") ? 3000 : false),
  });

  return (
    <div className="space-y-6">
      <EvalCaseList agentId={agent.id} cases={cases} canEdit={canEdit} />
      <EvalRunner
        agentId={agent.id}
        deployments={deployments}
        caseCount={cases.data?.length}
        canEdit={canEdit}
        onStarted={async (run) => {
          runs.setData((prev) => [run, ...(prev ?? []).filter((r) => r.id !== run.id)]);
          await runs.reload();
        }}
        onGoToTab={onGoToTab}
      />
      <EvalRunList runs={runs} deployments={deployments.data} />
    </div>
  );
}

function Chips({ items, tone }: { items: readonly string[]; tone: "positive" | "negative" }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {items.map((item, i) => (
        <li
          key={`${item}-${i}`}
          className={cn(
            "max-w-full truncate rounded-md px-2 py-0.5 text-xs ring-1 ring-inset",
            tone === "positive" ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : "bg-red-50 text-red-800 ring-red-200",
          )}
        >
          {item}
        </li>
      ))}
    </ul>
  );
}

function EvalCaseList({ agentId, cases, canEdit }: { agentId: string; cases: ActionQuery<EvalCaseDto[]>; canEdit: boolean }) {
  const [adding, setAdding] = useState(false);
  const [target, setTarget] = useState<EvalCaseDto | null>(null);
  const remove = useActionMutation(deleteEvalCaseAction, { successMessage: "テストケースを削除しました" });

  const addButton = canEdit ? (
    <Button size="sm" variant="secondary" icon={<Plus className="h-4 w-4" aria-hidden="true" />} onClick={() => setAdding(true)}>
      テストケースを追加
    </Button>
  ) : null;

  return (
    <Card>
      <CardHeader
        title="テストケース"
        description="指示と、出力に含まれるべき語・含まれてはいけない語を登録しておくと、デプロイしたエージェントをまとめて確かめられます。"
        actions={cases.data && cases.data.length > 0 ? addButton : null}
      />
      <QueryView
        query={cases}
        compactError
        loading={<TableSkeleton rows={3} columns={2} />}
        isEmpty={(items) => items.length === 0}
        empty={
          <EmptyState
            icon={ListChecks}
            title="テストケースはまだありません"
            description={canEdit ? "よくある指示と、期待する結果を登録してください。" : "テストケースが登録されると、ここに表示されます。"}
            action={addButton}
          />
        }
      >
        {(items) => (
          <ul className="divide-y divide-gray-100">
            {items.map((c) => (
              <li key={c.id} className="flex items-start gap-3 px-5 py-4">
                <div className="min-w-0 flex-1 space-y-2">
                  <p className="text-sm font-medium text-gray-900">{c.name}</p>
                  <p className="line-clamp-2 whitespace-pre-wrap break-words text-sm text-gray-600" title={c.input}>
                    {c.input}
                  </p>
                  {c.expectations.must_contain.length > 0 ? (
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-3">
                      <span className="shrink-0 pt-0.5 text-xs font-medium text-gray-500 sm:w-32">含むべき語</span>
                      <Chips items={c.expectations.must_contain} tone="positive" />
                    </div>
                  ) : null}
                  {c.expectations.must_not_contain.length > 0 ? (
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-3">
                      <span className="shrink-0 pt-0.5 text-xs font-medium text-gray-500 sm:w-32">含んではいけない語</span>
                      <Chips items={c.expectations.must_not_contain} tone="negative" />
                    </div>
                  ) : null}
                </div>
                {canEdit ? (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => setTarget(c)}
                    aria-label={`テストケース「${c.name}」を削除`}
                    className="text-gray-500 hover:text-red-600"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </QueryView>

      {adding ? (
        <EvalCaseDialog
          agentId={agentId}
          onClose={() => setAdding(false)}
          onCreated={(created) => cases.setData((prev) => [...(prev ?? []), created])}
        />
      ) : null}

      <ConfirmDialog
        open={target !== null}
        onClose={() => setTarget(null)}
        title={target ? `テストケース「${target.name}」を削除しますか？` : "テストケースを削除しますか？"}
        description="削除したテストケースは元に戻せません。これまでのテストの結果は残ります。"
        confirmLabel="削除する"
        onConfirm={async () => {
          if (!target) return;
          const res = await remove.mutate(target.id);
          if (!res.ok) return false;
          cases.setData((prev) => prev?.filter((c) => c.id !== target.id));
        }}
      />
    </Card>
  );
}

function EvalRunner({
  agentId,
  deployments,
  caseCount,
  canEdit,
  onStarted,
  onGoToTab,
}: {
  agentId: string;
  deployments: ActionQuery<DeploymentDto[]>;
  caseCount: number | undefined;
  canEdit: boolean;
  onStarted: (run: EvalRunDto) => Promise<void>;
  onGoToTab: (tab: AgentTab) => void;
}) {
  const [deploymentId, setDeploymentId] = useState("");
  const start = useActionMutation(startEvalRunAction, {
    successMessage: "テストを開始しました",
    onSuccess: onStarted,
  });

  if (!canEdit) return null;

  const active = activeDeployments(deployments.data);
  const selected = active.find((d) => d.id === deploymentId) ?? active[0];
  const noCases = caseCount === 0;

  return (
    <Card>
      <CardHeader title="テストを実行する" description="選んだデプロイで、すべてのテストケースを実行して結果を確かめます。" />
      <CardBody>
        {deployments.data === undefined ? (
          deployments.error ? (
            <ErrorState compact message={deployments.error.message} onRetry={deployments.reload} retrying={deployments.refreshing} />
          ) : (
            <SkeletonGroup>
              <Skeleton className="h-10 w-full max-w-md" />
            </SkeletonGroup>
          )
        ) : !selected ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-gray-600">稼働中のデプロイがありません。テストの前に、公開したバージョンをデプロイしてください。</p>
            <Button size="sm" variant="secondary" onClick={() => onGoToTab("deploy")}>
              デプロイの画面へ
            </Button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (noCases || start.pending) return;
              void start.mutate(agentId, { deployment_id: selected.id });
            }}
          >
            <div className="min-w-0 flex-1 sm:max-w-md">
              <DeploymentSelect
                label="どのデプロイでテストしますか？"
                deployments={active}
                value={selected.id}
                onChange={setDeploymentId}
                disabled={start.pending}
              />
            </div>
            <Button
              type="submit"
              loading={start.pending}
              disabled={noCases}
              icon={<Play className="h-4 w-4" aria-hidden="true" />}
            >
              テストを実行
            </Button>
          </form>
        )}
        {noCases && selected ? <p className="mt-2 text-xs text-gray-500">テストケースを追加すると実行できます。</p> : null}
      </CardBody>
    </Card>
  );
}

function EvalRunList({ runs, deployments }: { runs: ActionQuery<EvalRunDto[]>; deployments: DeploymentDto[] | undefined }) {
  const [showAll, setShowAll] = useState(false);
  return (
    <section aria-labelledby="eval-results-heading" className="space-y-4">
      <h2 id="eval-results-heading" className="text-base font-semibold text-gray-900">
        テストの結果
      </h2>
      <QueryView
        query={runs}
        loading={<CardSkeleton />}
        isEmpty={(items) => items.length === 0}
        empty={
          <Card>
            <EmptyState icon={FlaskConical} title="まだテストを実行していません" description="テストを実行すると、ケースごとの結果がここに表示されます。" />
          </Card>
        }
      >
        {(items) => {
          const visible = showAll ? items : items.slice(0, RUNS_PAGE);
          return (
            <div className="space-y-4">
              {visible.map((run) => (
                <EvalRunCard key={run.id} run={run} deployment={deployments?.find((d) => d.id === run.deployment_id)} />
              ))}
              {items.length > RUNS_PAGE ? (
                <div className="flex justify-center">
                  <Button variant="secondary" size="sm" onClick={() => setShowAll((v) => !v)}>
                    {showAll ? "新しい 5 件だけ表示" : `すべて表示（${items.length} 件）`}
                  </Button>
                </div>
              ) : null}
            </div>
          );
        }}
      </QueryView>
    </section>
  );
}

function EvalRunCard({ run, deployment }: { run: EvalRunDto; deployment: DeploymentDto | undefined }) {
  const total = run.results.length;
  const passed = run.results.filter((r) => r.status === "passed").length;
  return (
    <Card>
      <div className="flex flex-col gap-2 border-b border-gray-100 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <EvalRunStatusBadge status={run.status} />
          <span className="text-sm font-medium text-gray-900">
            {total} 件中 {passed} 件が合格
          </span>
          {deployment ? <span className="text-sm text-gray-500">・{deploymentLabel(deployment)}</span> : null}
        </div>
        <p className="text-xs text-gray-500">
          開始 <TimeAgo value={run.created_at} />
          {run.finished_at ? (
            <>
              ・終了 <TimeAgo value={run.finished_at} />
            </>
          ) : null}
        </p>
      </div>
      {total === 0 ? (
        <p className="px-5 py-4 text-sm text-gray-500">結果はまだありません。</p>
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>テストケース</TH>
              <TH>結果</TH>
              <TH>理由</TH>
              <TH>
                <span className="sr-only">実行の詳細</span>
              </TH>
            </tr>
          </THead>
          <TBody>
            {run.results.map((r) => (
              <TR key={r.case_id}>
                <TD className="max-w-[12rem] font-medium text-gray-900">
                  <span className="block truncate" title={r.case_name}>
                    {r.case_name}
                  </span>
                </TD>
                <TD>
                  <EvalResultStatusBadge status={r.status} />
                </TD>
                <TD className="min-w-[12rem]">
                  {r.reasons.length > 0 ? (
                    <ul className="list-disc space-y-0.5 pl-4 text-sm text-gray-700">
                      {r.reasons.map((reason, i) => (
                        <li key={i}>{reason}</li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </TD>
                <TD className="text-right">
                  {r.run_id ? (
                    <Link
                      href={`/runs/${r.run_id}`}
                      className="inline-flex items-center gap-1 whitespace-nowrap text-sm font-medium text-accent-700 hover:underline"
                      aria-label={`「${r.case_name}」の実行の詳細`}
                    >
                      詳細
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    </Link>
                  ) : null}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}
