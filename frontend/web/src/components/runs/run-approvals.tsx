"use client";

import type { ApprovalDto, RunStatus } from "@agent-studio/contracts";
import { ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef } from "react";
import { listApprovalsAction } from "@/actions/approvals";
import { ApprovalCard } from "@/components/approvals/approval-card";
import { Alert } from "@/components/ui/alert";
import { CardSkeleton } from "@/components/ui/skeleton";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";

const APPROVAL_POLL_MS = 3_000;

export interface RunApprovalsProps {
  runId: string;
  status: RunStatus;
  /** 経過に承認の依頼が含まれているか */
  hasRequests: boolean;
  onDecided?: (approval: ApprovalDto) => void;
}

/** 実行の詳細画面に出す「承認が必要な操作」 */
export function RunApprovals({ runId, status, hasRequests, onDecided }: RunApprovalsProps) {
  const { can, organization } = useSession();
  const canDecide = can("approval.decide");
  const headingId = useId();
  const waiting = status === "waiting_approval";

  const query = useActionQuery(() => listApprovalsAction({ status: "pending" }), [organization?.id], {
    enabled: waiting || hasRequests,
    refetchInterval: waiting ? APPROVAL_POLL_MS : false,
  });
  const { reload, setData } = query;

  // 承認待ちになったら、すぐに取り直して定期的な取得を再開する
  const wasWaiting = useRef(waiting);
  useEffect(() => {
    if (waiting && !wasWaiting.current) void reload();
    wasWaiting.current = waiting;
  }, [waiting, reload]);

  const approvals = (query.data ?? []).filter((a) => a.run_id === runId);

  if (approvals.length === 0) {
    if (!waiting) return null;
    if (query.data === undefined && !query.error) {
      return <CardSkeleton />;
    }
    return (
      <Alert
        tone={query.error ? "warning" : "info"}
        title={query.error ? "承認の依頼を読み込めませんでした" : "承認を待っています"}
      >
        {query.error ? (
          query.error.message
        ) : (
          <>
            承認の依頼を確認しています。表示されない場合は{" "}
            <Link href="/approvals" className="font-medium underline">
              承認の画面
            </Link>{" "}
            を確認してください。
          </>
        )}
      </Alert>
    );
  }

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div>
        <h2 id={headingId} className="flex items-center gap-2 text-base font-semibold text-gray-900">
          <ShieldAlert className="h-5 w-5 text-amber-500" aria-hidden="true" />
          承認が必要な操作
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">{approvals.length}件</span>
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-gray-500">
          {canDecide
            ? "内容を確認して、承認または却下してください。承認されるまで、エージェントはこの操作を行いません。"
            : "承認者が判断するまで、エージェントはこの操作を行いません。"}
        </p>
      </div>
      {query.error ? (
        <Alert tone="warning" title="最新の承認の状態を読み込めませんでした">
          {query.error.message}
        </Alert>
      ) : null}
      {approvals.map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          canDecide={canDecide}
          hideRunLink
          onDecided={(decided) => {
            setData((prev) => prev?.filter((a) => a.id !== approval.id));
            onDecided?.(decided);
          }}
        />
      ))}
    </section>
  );
}
