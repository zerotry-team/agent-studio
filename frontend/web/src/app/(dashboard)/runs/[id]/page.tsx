"use client";

import { Ban } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { cancelRunAction } from "@/actions/runs";
import { ErrorState } from "@/components/common/error-state";
import { PageHeader } from "@/components/common/page-header";
import { RunStatusBadge, StageBadge } from "@/components/common/status-badges";
import { TimeAgo } from "@/components/common/time-ago";
import { LiveIndicator } from "@/components/runs/live-indicator";
import { listApprovalsAction } from "@/actions/approvals";
import { RunArtifacts } from "@/components/runs/run-artifacts";
import { RunEventTimeline } from "@/components/runs/run-event-timeline";
import { RunMessageForm } from "@/components/runs/run-message-form";
import { RunInfoCard, RunOutputPlaceholder, RunTextPanel } from "@/components/runs/run-panels";
import { isTerminalRunStatus, useRunStream } from "@/components/runs/use-run-stream";
import { useActionQuery } from "@/hooks/use-action-query";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyButton } from "@/components/ui/copy-button";
import { CardSkeleton, Skeleton } from "@/components/ui/skeleton";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { useSession } from "@/hooks/use-session";

function RunDetailSkeleton() {
  return (
    <>
      <div className="mb-6 space-y-3" aria-hidden="true">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-7 w-64 max-w-full" />
        <Skeleton className="h-4 w-48" />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
        </div>
        <CardSkeleton />
      </div>
    </>
  );
}

export default function RunDetailPage({ params }: { params: { id: string } }) {
  const runId = params.id;
  const { can, organization } = useSession();
  const stream = useRunStream(runId);
  const { run, events, resume, setRun } = stream;
  const [confirmCancel, setConfirmCancel] = useState(false);

  const cancel = useActionMutation(cancelRunAction, {
    successMessage: "実行を中止しました",
    onSuccess: (updated) => {
      setRun(updated);
      // 中止までの最後の経過を受け取る
      resume();
    },
  });

  const approvalRevision = events.filter((e) => e.type === "approval.requested" || e.type === "approval.decided").map((e) => e.seq).join(",");
  const hasApprovalRequests = events.some((e) => e.type === "approval.requested");
  // 経過の中で承認できるようにするため、この実行ぶんの依頼をここで読む（フックは早期 return より前に置く）
  const approvals = useActionQuery(() => listApprovalsAction({ status: "pending" }), [organization?.id, runId, run?.status, approvalRevision], {
    enabled: run?.status === "waiting_approval" || hasApprovalRequests,
    refetchInterval: () => (run && !isTerminalRunStatus(run.status) ? 3_000 : false),
  });

  if (!run) {
    if (stream.error) {
      return (
        <>
          <PageHeader title="実行の詳細" back={{ href: "/runs", label: "実行履歴" }} />
          <ErrorState message={stream.error.message} onRetry={stream.reload} retrying={stream.loading} />
        </>
      );
    }
    return <RunDetailSkeleton />;
  }

  const terminal = isTerminalRunStatus(run.status);
  const canStart = can("run.start");
  const canCancel = canStart && !terminal;
  const canMessage = canStart && run.status !== "cancelled" && run.status !== "failed";
  const activeExternalJobs = run.external_jobs.filter((job) => job.status === "pending" || job.status === "processing");
  const publishedJobs = run.external_jobs.filter((job) => job.status === "succeeded" && job.permalink);

  return (
    <>
      <PageHeader
        back={{ href: "/runs", label: "実行履歴" }}
        title={
          <Link
            href={`/agents/${run.agent.id}`}
            className="rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
          >
            {run.agent.name}
          </Link>
        }
        meta={
          <>
            <Badge tone="neutral">v{run.agent.version}</Badge>
            <span role="status" aria-live="polite">
              <RunStatusBadge status={run.status} outcome={run.outcome} />
            </span>
            <StageBadge stage={run.deployment.stage} />
          </>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{run.runtime_profile.name} で実行</span>
            <span className="text-gray-300" aria-hidden="true">
              |
            </span>
            <span>
              受け付け: <TimeAgo value={run.created_at} />
            </span>
            {stream.polling ? <LiveIndicator /> : null}
          </span>
        }
        actions={
          canCancel ? (
            <Button variant="danger-outline" icon={<Ban className="h-4 w-4" aria-hidden="true" />} onClick={() => setConfirmCancel(true)}>
              中止する
            </Button>
          ) : null
        }
      />

      {stream.pollError ? (
        <Alert tone="warning" className="mb-6" title="最新の状態を読み込めませんでした">
          {stream.pollError}
          {stream.polling ? "（自動でもう一度読み込みます）" : null}
        </Alert>
      ) : null}

      {run.outcome === "completed_with_errors" ? (
        <Alert tone="warning" className="mb-6" title="一部の操作を完了できませんでした">
          エージェントの回答は完了しましたが、外部サービスへの操作に失敗があります。下の経過で失敗内容と承認履歴を確認してください。
        </Alert>
      ) : null}

      {activeExternalJobs.length > 0 ? (
        <Alert tone="info" className="mb-6" title="外部サービスの処理結果を確認しています">
          投稿要求は受け付け済みです。Agent Studioは同じ投稿を再送せず、Job IDを使って結果だけを確認しています。
        </Alert>
      ) : null}

      {publishedJobs.length > 0 ? (
        <Alert tone="success" className="mb-6" title="外部投稿の完了を確認しました">
          {publishedJobs.map((job) => (
            <p key={job.id}>
              Provider Job {job.provider_job_id} は成功しました。{" "}
              <a className="font-medium underline" href={job.permalink!} target="_blank" rel="noreferrer">投稿を確認</a>
            </p>
          ))}
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {run.error ? (
            <Alert tone="danger" title="エラーが発生しました">
              <p className="whitespace-pre-wrap break-words">{run.error}</p>
            </Alert>
          ) : null}

          {run.status === "requires_action" && canMessage ? (
            <Alert tone="warning" title="エージェントが指示を待っています">
              画面の下の「追加の指示」から、続けて伝えたいことを送ってください。
            </Alert>
          ) : null}

          <RunTextPanel title="指示" text={run.input} placeholder="—" />

          <RunTextPanel
            title="結果"
            runId={run.id}
            text={run.output}
            format="rich"
            placeholder={<RunOutputPlaceholder run={run} />}
            actions={run.output ? <CopyButton value={run.output} label="結果をコピー" /> : null}
          />

          <RunArtifacts runId={run.id} finished={terminal} />

          {approvals.error ? <Alert tone="warning" title="承認依頼を取得できませんでした"><p>{approvals.error.message}</p><Button variant="secondary" size="sm" onClick={() => void approvals.reload()}>再取得</Button></Alert> : null}
          <RunEventTimeline
            events={events}
            finished={terminal}
            running={run.status === "running" || run.status === "provisioning" || run.status === "queued"}
            approvals={(approvals.data ?? []).filter((approval) => approval.run_id === run.id)}
            onApprovalDecided={() => {
              void approvals.reload();
              resume();
            }}
          />

          {canMessage ? <RunMessageForm runId={run.id} onSent={resume} /> : null}
        </div>

        <div className="min-w-0 space-y-6">
          <RunInfoCard run={run} />
        </div>
      </div>

      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title="この実行を中止しますか？"
        description="エージェントの作業を途中で止めます。すでに行われた操作は元に戻りません。中止した実行は再開できません。"
        confirmLabel="中止する"
        tone="danger"
        onConfirm={async () => {
          const res = await cancel.mutate(run.id);
          return res.ok ? undefined : false;
        }}
      />
    </>
  );
}
