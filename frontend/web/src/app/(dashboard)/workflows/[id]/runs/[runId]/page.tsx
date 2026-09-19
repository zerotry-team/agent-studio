"use client";

import { listApprovalsAction } from "@/actions/approvals";
import { getWorkflowAction, getWorkflowRunAction } from "@/actions/workflows";
import { ErrorState } from "@/components/common/error-state";
import { PageHeader } from "@/components/common/page-header";
import { WorkflowRunStatusBadge } from "@/components/common/status-badges";
import { TimeAgo } from "@/components/common/time-ago";
import { LiveIndicator } from "@/components/runs/live-indicator";
import { RunTextPanel } from "@/components/runs/run-panels";
import { WorkflowRunSteps } from "@/components/workflows/workflow-run-steps";
import { isActiveWorkflowRun } from "@/components/workflows/workflow-runs-panel";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CardSkeleton, Skeleton } from "@/components/ui/skeleton";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";
import { formatDateTime } from "@/lib/utils/format";

const RUN_POLL_MS = 3_000;
const APPROVAL_POLL_MS = 3_000;

function WorkflowRunSkeleton() {
  return (
    <>
      <div className="mb-6 space-y-3" aria-hidden="true">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-7 w-64 max-w-full" />
        <Skeleton className="h-4 w-40" />
      </div>
      <div className="space-y-6">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    </>
  );
}

export default function WorkflowRunPage({ params }: { params: { id: string; runId: string } }) {
  const { can, organization } = useSession();
  const back = { href: `/workflows/${params.id}?tab=runs`, label: "ワークフローの実行履歴" };

  const runQuery = useActionQuery(() => getWorkflowRunAction(params.runId), [organization?.id, params.runId], {
    refetchInterval: (data) => (data && isActiveWorkflowRun(data) ? RUN_POLL_MS : false),
  });
  const workflowQuery = useActionQuery(() => getWorkflowAction(params.id), [organization?.id, params.id]);

  const run = runQuery.data;
  const waitingForApproval = !!run?.steps.some((s) => s.type === "approval" && s.status === "waiting_approval" && s.approval_id);
  const approvals = useActionQuery(() => listApprovalsAction({ status: "pending" }), [organization?.id], {
    enabled: waitingForApproval,
    refetchInterval: waitingForApproval ? APPROVAL_POLL_MS : false,
  });

  if (!run) {
    if (runQuery.error) {
      return (
        <>
          <PageHeader title="ワークフローの実行" back={back} />
          <ErrorState message={runQuery.error.message} onRetry={runQuery.reload} retrying={runQuery.refreshing} />
        </>
      );
    }
    return <WorkflowRunSkeleton />;
  }

  const workflow = workflowQuery.data;
  const versionChanged = !!workflow && workflow.version !== run.workflow.version;
  const active = isActiveWorkflowRun(run);
  const completedSteps = run.steps.filter((s) => s.status === "completed").length;

  return (
    <>
      <PageHeader
        back={back}
        title={run.workflow.name}
        meta={
          <>
            <Badge tone="neutral">v{run.workflow.version}</Badge>
            <span role="status" aria-live="polite">
              <WorkflowRunStatusBadge status={run.status} />
            </span>
          </>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              開始: <TimeAgo value={run.created_at} />
            </span>
            {run.finished_at ? <span>終了: {formatDateTime(run.finished_at)}</span> : null}
            <span>
              {completedSteps} / {run.steps.length} ステップ完了
            </span>
            {active ? <LiveIndicator /> : null}
          </span>
        }
      />

      <div className="space-y-6">
        {runQuery.error ? (
          <Alert tone="warning" title="最新の状態を読み込めませんでした">
            {runQuery.error.message}
          </Alert>
        ) : null}

        {versionChanged ? (
          <Alert tone="info" title="この実行のあとに、ワークフローの定義が変更されています">
            この実行はバージョン {run.workflow.version} の定義で進んでいます（現在はバージョン {workflow.version}）。ステップの名前は現在の定義から表示しているため、異なる場合があります。
          </Alert>
        ) : null}

        {run.status === "failed" ? (
          <Alert tone="danger" title="ワークフローが失敗しました">
            失敗したステップの「実行の詳細」から、原因を確認してください。
          </Alert>
        ) : null}

        <RunTextPanel title="ワークフローへの入力" text={run.input} placeholder="（入力はありません）" />

        <Card>
          <CardHeader title="ステップ" description="上から順番に進みます。" />
          <CardBody>
            {workflowQuery.error ? (
              <p className="mb-4 text-xs text-gray-500">ワークフローの定義を読み込めなかったため、ステップはキーで表示しています。</p>
            ) : null}
            {approvals.error && waitingForApproval ? (
              <Alert tone="warning" className="mb-4" title="承認の依頼を読み込めませんでした">
                {approvals.error.message}
              </Alert>
            ) : null}
            {run.steps.length === 0 ? (
              <p className="text-sm text-gray-500">ステップはまだ始まっていません。</p>
            ) : (
              <WorkflowRunSteps
                run={run}
                definition={workflow?.definition}
                approvals={approvals.data}
                approvalsLoading={approvals.loading}
                canDecide={can("approval.decide")}
                onDecided={(decided) => {
                  approvals.setData((prev) => prev?.filter((a) => a.id !== decided.id));
                  void runQuery.reload();
                }}
              />
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
