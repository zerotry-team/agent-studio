"use client";

import type { ApprovalDto, WorkflowDto, WorkflowRunDto } from "@agent-studio/contracts";
import { Bot, Check, ExternalLink, ShieldCheck, X } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { ApprovalCard } from "@/components/approvals/approval-card";
import { WorkflowStepStatusBadge } from "@/components/common/status-badges";
import { CardSkeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils/cn";
import type { WorkflowStepStatus } from "@/lib/utils/labels";
import { STEP_TYPE_LABELS } from "./step-drafts";

type RunStep = WorkflowRunDto["steps"][number];
type DefinitionStep = WorkflowDto["definition"]["steps"][number];

const LONG_TEXT_CHARS = 600;
const LONG_TEXT_LINES = 10;

/** 長い文章は折りたたんで表示する */
function CollapsibleText({ text, label }: { text: string; label: string }) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const long = text.length > LONG_TEXT_CHARS || text.split("\n").length > LONG_TEXT_LINES;
  return (
    <div>
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <div className="relative mt-1">
        <div
          id={contentId}
          className={cn(
            "whitespace-pre-wrap break-words rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm leading-relaxed text-gray-800",
            long && !expanded && "max-h-48 overflow-hidden",
          )}
        >
          {text}
        </div>
        {long && !expanded ? (
          <div className="pointer-events-none absolute inset-x-px bottom-px h-12 rounded-b-lg bg-gradient-to-t from-gray-50 to-transparent" aria-hidden="true" />
        ) : null}
      </div>
      {long ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={contentId}
          className="mt-1.5 rounded text-xs font-medium text-accent-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
        >
          {expanded ? "折りたたむ" : "すべて表示"}
        </button>
      ) : null}
    </div>
  );
}

function StepMarker({ status, index }: { status: WorkflowStepStatus; index: number }) {
  const base = "relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ring-4 ring-white";
  if (status === "completed") {
    return (
      <span className={cn(base, "bg-emerald-500 text-white")} aria-hidden="true">
        <Check className="h-4 w-4" />
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className={cn(base, "bg-red-500 text-white")} aria-hidden="true">
        <X className="h-4 w-4" />
      </span>
    );
  }
  const tone =
    status === "running"
      ? "bg-accent-600 text-white"
      : status === "waiting_approval"
        ? "bg-amber-400 text-white"
        : status === "skipped"
          ? "border border-dashed border-gray-300 bg-white text-gray-400"
          : "border border-gray-300 bg-white text-gray-500";
  return (
    <span className={cn(base, tone)} aria-hidden="true">
      {status === "running" ? <span className="absolute inset-0 animate-ping rounded-full bg-accent-400 opacity-30" /> : null}
      <span className="relative">{index + 1}</span>
    </span>
  );
}

export interface WorkflowRunStepsProps {
  run: WorkflowRunDto;
  /** 現在のワークフローの定義（ステップ名・種類・メッセージを表示するため） */
  definition: WorkflowDto["definition"] | undefined;
  approvals: ApprovalDto[] | undefined;
  approvalsLoading: boolean;
  canDecide: boolean;
  onDecided: (approval: ApprovalDto) => void;
}

/** ワークフローの実行の進み具合（縦に並べたステップ） */
export function WorkflowRunSteps({ run, definition, approvals, approvalsLoading, canDecide, onDecided }: WorkflowRunStepsProps) {
  const findDefinition = (key: string): DefinitionStep | undefined => definition?.steps.find((s) => s.key === key);

  return (
    <ol aria-label="ステップの進み具合">
      {run.steps.map((step, index) => (
        <StepItem
          key={step.key}
          step={step}
          index={index}
          isLast={index === run.steps.length - 1}
          isCurrent={run.current_step === step.key}
          definition={findDefinition(step.key)}
          approvals={approvals}
          approvalsLoading={approvalsLoading}
          canDecide={canDecide}
          onDecided={onDecided}
        />
      ))}
    </ol>
  );
}

function StepItem({
  step,
  index,
  isLast,
  isCurrent,
  definition,
  approvals,
  approvalsLoading,
  canDecide,
  onDecided,
}: {
  step: RunStep;
  index: number;
  isLast: boolean;
  isCurrent: boolean;
  definition: DefinitionStep | undefined;
  approvals: ApprovalDto[] | undefined;
  approvalsLoading: boolean;
  canDecide: boolean;
  onDecided: (approval: ApprovalDto) => void;
}) {
  const TypeIcon = step.type === "agent" ? Bot : ShieldCheck;
  const name = definition?.name ?? step.key;
  const waitingApproval = step.type === "approval" && step.status === "waiting_approval";
  const approval = step.approval_id ? approvals?.find((a) => a.id === step.approval_id) : undefined;

  return (
    <li className="relative flex gap-4 pb-6 last:pb-0" aria-current={isCurrent ? "step" : undefined}>
      {!isLast ? <span className="absolute bottom-0 left-4 top-8 w-px -translate-x-1/2 bg-gray-200" aria-hidden="true" /> : null}
      <StepMarker status={step.status} index={index} />
      <div
        className={cn(
          "min-w-0 flex-1 rounded-xl border bg-white px-4 py-3.5 shadow-sm sm:px-5",
          isCurrent && (step.status === "running" || step.status === "waiting_approval")
            ? "border-accent-200 ring-1 ring-accent-100"
            : "border-gray-200",
        )}
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900">
              <span className="sr-only">ステップ {index + 1}: </span>
              {name}
            </p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-gray-500">
              <span className="inline-flex items-center gap-1">
                <TypeIcon className="h-3.5 w-3.5" aria-hidden="true" />
                {STEP_TYPE_LABELS[step.type]}
              </span>
              <span className="font-mono">{step.key}</span>
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-3">
            <WorkflowStepStatusBadge status={step.status} />
            {step.type === "agent" && step.run_id ? (
              <Link
                href={`/runs/${step.run_id}`}
                className="inline-flex items-center gap-1 rounded text-sm font-medium text-accent-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
              >
                実行の詳細
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            ) : null}
          </div>
        </div>

        <div className="mt-3 space-y-3 empty:mt-0">
          {definition?.type === "approval" ? (
            <div>
              <p className="text-xs font-medium text-gray-500">承認者へのメッセージ</p>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-800">{definition.message}</p>
            </div>
          ) : null}

          {step.output ? <CollapsibleText text={step.output} label={step.type === "agent" ? "結果" : "判断の内容"} /> : null}

          {step.type === "agent" && step.status === "waiting_approval" ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              エージェントの操作が承認を待っています。
              {step.run_id ? (
                <>
                  {" "}
                  <Link href={`/runs/${step.run_id}`} className="font-medium underline">
                    実行の詳細で確認する
                  </Link>
                </>
              ) : null}
            </p>
          ) : null}

          {waitingApproval ? (
            approval ? (
              <ApprovalCard approval={approval} canDecide={canDecide} onDecided={onDecided} hideRunLink className="shadow-none" />
            ) : approvals === undefined && approvalsLoading ? (
              <CardSkeleton />
            ) : (
              <p className="text-sm text-gray-600">
                承認を待っています。{" "}
                <Link href="/approvals" className="font-medium text-accent-700 hover:underline">
                  承認の画面で確認する
                </Link>
              </p>
            )
          ) : null}
        </div>
      </div>
    </li>
  );
}
