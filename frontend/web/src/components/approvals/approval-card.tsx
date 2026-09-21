"use client";

import type { ApprovalDto } from "@agent-studio/contracts";
import { Check, Clock, ExternalLink, X } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { decideApprovalAction } from "@/actions/approvals";
import { ApprovalStatusBadge } from "@/components/common/status-badges";
import { TimeAgo } from "@/components/common/time-ago";
import { Button } from "@/components/ui/button";
import { JsonView } from "@/components/ui/code-block";
import { Textarea } from "@/components/ui/input";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { cn } from "@/lib/utils/cn";
import { formatDateTime } from "@/lib/utils/format";

export interface ApprovalCardProps {
  approval: ApprovalDto;
  /** 承認権限があるか（is_approver） */
  canDecide: boolean;
  onDecided?: (approval: ApprovalDto) => void;
  /** 実行の詳細画面の中で使うとき（実行へのリンクを出さない） */
  hideRunLink?: boolean;
  className?: string;
}

function isExpired(approval: ApprovalDto): boolean {
  return approval.status === "pending" && new Date(approval.expires_at).getTime() < Date.now();
}

/** 承認依頼 1 件。承認者には承認・却下のボタンを表示する */
export function ApprovalCard({ approval, canDecide, onDecided, hideRunLink = false, className }: ApprovalCardProps) {
  const [comment, setComment] = useState("");
  const [decision, setDecision] = useState<"approve" | "deny" | null>(null);
  const commentId = useId();
  const mutation = useActionMutation(decideApprovalAction, {
    successMessage: (a) => (a.status === "approved" ? "承認しました" : a.status === "denied" ? "却下しました" : "判断を送りました"),
    onSuccess: (a) => {
      setComment("");
      onDecided?.(a);
    },
  });

  const expired = isExpired(approval);
  const pending = approval.status === "pending" && !expired;

  const decide = async (d: "approve" | "deny") => {
    setDecision(d);
    await mutation.mutate(approval.id, { decision: d, comment: comment.trim() || undefined });
    setDecision(null);
  };

  return (
    <article
      className={cn(
        "rounded-xl border bg-white shadow-sm",
        pending ? "border-amber-200" : "border-gray-200",
        className,
      )}
      aria-label={`承認依頼: ${approval.tool}`}
    >
      <div className="flex flex-col gap-3 border-b border-gray-100 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-semibold text-gray-900">{approval.tool}</span>
            <ApprovalStatusBadge status={expired ? "expired" : approval.status} />
            {approval.auto_approved ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">組織Policy</span> : null}
          </div>
          <p className="text-sm text-gray-500">
            {approval.agent ? (
              <>
                <Link href={`/agents/${approval.agent.id}`} className="font-medium text-gray-700 hover:underline">
                  {approval.agent.name}
                </Link>{" "}
                が実行しようとしています
              </>
            ) : approval.source === "builder" ? "Builderの変更操作です" : approval.source === "workflow" ? "Workflowの操作です" : "エージェントが実行しようとしています"}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-start gap-1 text-xs text-gray-500 sm:items-end">
          <span>
            依頼: <TimeAgo value={approval.requested_at} />
          </span>
          {approval.status === "pending" ? (
            <span className={cn("inline-flex items-center gap-1", expired ? "text-red-600" : "text-amber-700")}>
              <Clock className="h-3.5 w-3.5" aria-hidden="true" />
              {expired ? "期限切れ" : <>期限: {formatDateTime(approval.expires_at)}（<TimeAgo value={approval.expires_at} />）</>}
            </span>
          ) : null}
          {!hideRunLink && approval.run_id ? (
            <Link href={`/runs/${approval.run_id}`} className="inline-flex items-center gap-1 font-medium text-accent-700 hover:underline">
              実行の詳細
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          ) : null}
        </div>
      </div>

      <div className="space-y-4 px-5 py-4">
        <div>
          <p className="text-xs font-medium text-gray-500">承認が必要な理由</p>
          <p className="mt-1 text-sm leading-relaxed text-gray-800">{approval.reason}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-gray-500">実行する内容（引数）</p>
          <JsonView value={approval.args_preview} className="mt-1" maxHeight="16rem" />
        </div>

        {approval.status !== "pending" ? (
          <div className="rounded-lg bg-gray-50 px-4 py-3 text-sm text-gray-700">
            <p>
              {approval.auto_approved ? "組織Policy" : approval.decided_by ?? "システム"} が {formatDateTime(approval.decided_at)} に判断しました
            </p>
            {approval.auto_approved ? (
              <p className="mt-1 text-gray-600">
                Policy v{approval.auto_approval_policy_version ?? "-"}: {approval.auto_approval_reason ?? "許可範囲内"}
              </p>
            ) : null}
            {approval.comment ? <p className="mt-1 whitespace-pre-wrap text-gray-600">コメント: {approval.comment}</p> : null}
          </div>
        ) : null}
      </div>

      {pending ? (
        canDecide ? (
          <div className="space-y-3 border-t border-gray-100 bg-gray-50/60 px-5 py-4 sm:rounded-b-xl">
            <div className="space-y-1.5">
              <label htmlFor={commentId} className="text-sm font-medium text-gray-800">
                コメント <span className="text-xs font-normal text-gray-500">（任意）</span>
              </label>
              <Textarea
                id={commentId}
                rows={2}
                value={comment}
                maxLength={1000}
                onChange={(e) => setComment(e.target.value)}
                placeholder="判断の理由など"
              />
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                variant="danger-outline"
                onClick={() => decide("deny")}
                loading={mutation.pending && decision === "deny"}
                disabled={mutation.pending}
                icon={<X className="h-4 w-4" aria-hidden="true" />}
              >
                却下する
              </Button>
              <Button
                onClick={() => decide("approve")}
                loading={mutation.pending && decision === "approve"}
                disabled={mutation.pending}
                icon={<Check className="h-4 w-4" aria-hidden="true" />}
              >
                承認して実行する
              </Button>
            </div>
          </div>
        ) : (
          <p className="border-t border-gray-100 px-5 py-3 text-xs text-gray-500">
            承認・却下は、承認の権限を持つメンバーだけが行えます。
          </p>
        )
      ) : null}
    </article>
  );
}
