"use client";

import type { ApprovalDto, RunEventDto, ToolDto } from "@agent-studio/contracts";
import { ArrowDownToLine, CircleAlert, Clock, Loader2, MessageSquare, Server, User } from "lucide-react";
import { useId, useMemo } from "react";
import { listConnectorsAction } from "@/actions/connectors";
import { ApprovalCard } from "@/components/approvals/approval-card";
import { ToolRiskBadge } from "@/components/common/status-badges";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { JsonView } from "@/components/ui/code-block";
import { EmptyState } from "@/components/ui/empty-state";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";
import { cn } from "@/lib/utils/cn";
import { formatTime } from "@/lib/utils/format";
import { buildRunSteps, type RunStep } from "./run-steps";

/** 手順がこれより多いと「最新へ移動」を出す */
const JUMP_LINK_THRESHOLD = 5;

function StepShell({
  index,
  at,
  icon,
  tone,
  title,
  badge,
  children,
  isLast,
}: {
  index: number | null;
  at: string;
  icon: React.ReactNode;
  tone: string;
  title: React.ReactNode;
  badge?: React.ReactNode;
  children?: React.ReactNode;
  isLast: boolean;
}) {
  return (
    <li className="relative flex gap-3 pb-5 last:pb-0">
      {!isLast ? <span aria-hidden="true" className="absolute left-[15px] top-8 bottom-0 w-px bg-gray-200" /> : null}
      <span className={cn("relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full", tone)}>
        {index !== null ? <span className="text-xs font-semibold">{index}</span> : icon}
      </span>
      <div className="min-w-0 flex-1 pt-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-gray-900">{title}</span>
          {badge}
          <time className="ml-auto shrink-0 text-xs text-gray-400">{formatTime(at)}</time>
        </div>
        {children}
      </div>
    </li>
  );
}

function ActionStep({
  step,
  index,
  isLast,
  active,
  approval,
  canDecide,
  onDecided,
  finished,
}: {
  step: Extract<RunStep, { kind: "action" }>;
  index: number;
  isLast: boolean;
  /** いま動いている手順か */
  active: boolean;
  approval: ApprovalDto | undefined;
  canDecide: boolean;
  finished: boolean;
  onDecided?: (approval: ApprovalDto) => void;
}) {
  const waiting = !finished && step.approval === "pending" && (!approval || approval.status === "pending");
  const tone =
    step.state === "failed"
      ? "bg-red-50 text-red-600"
      : step.state === "succeeded"
        ? "bg-emerald-50 text-emerald-700"
        : "bg-amber-50 text-amber-700";

  return (
    <StepShell
      index={index}
      at={step.at}
      icon={null}
      tone={tone}
      isLast={isLast}
      title={
        <>
          {step.connectorName ? <span className="text-gray-500">{step.connectorName}で</span> : null}
          <span className="ml-1">{step.label}</span>
        </>
      }
      badge={
        <>
          {step.risk ? <ToolRiskBadge risk={step.risk} /> : null}
          {step.state === "failed" ? <Badge tone="danger">できませんでした</Badge> : null}
          {step.state === "succeeded" ? <Badge tone="success">完了</Badge> : null}
          {waiting ? <Badge tone="warning">承認待ち</Badge> : null}
          {step.approval === "denied" ? <Badge tone="neutral">却下されました</Badge> : null}
          {active && !waiting && step.state !== "succeeded" && step.state !== "failed" ? (
            <Badge tone="info">
              <Loader2 className="mr-1 inline h-3 w-3 animate-spin" aria-hidden="true" />
              実行中
            </Badge>
          ) : null}
        </>
      }
    >
      {step.description ? <p className="mt-0.5 text-xs text-gray-500">{step.description}</p> : null}

      {step.error ? (
        <p className="mt-2 whitespace-pre-wrap break-words rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-900">
          {step.error}
        </p>
      ) : null}

      {waiting && !approval ? <p className="mt-2 text-sm text-amber-700" role="status">承認依頼を取得しています…</p> : null}
      {waiting && approval ? (
        <div className="mt-2.5">
          <ApprovalCard approval={approval} canDecide={canDecide} onDecided={onDecided} hideRunLink />
        </div>
      ) : null}

      {step.args ? (
        <details className="group mt-2">
          <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-700">送信する内容を見る</summary>
          <JsonView value={step.args} className="mt-2" maxHeight="18rem" />
        </details>
      ) : null}
    </StepShell>
  );
}

export interface RunEventTimelineProps {
  events: RunEventDto[];
  /** 実行が終わっているか（空のときの表示を変える） */
  finished: boolean;
  /** 動いている最中なら、最後のステップを「実行中」として見せる */
  running?: boolean;
  /** この実行の承認依頼。経過の中で承認できるようにする */
  approvals?: ApprovalDto[];
  onApprovalDecided?: (approval: ApprovalDto) => void;
}

/** 実行の経過。エージェントが何をしたかを手順として並べる（古い順） */
export function RunEventTimeline({ events, finished, running = false, approvals = [], onApprovalDecided }: RunEventTimelineProps) {
  const { can, organization } = useSession();
  const endId = useId();
  const connectors = useActionQuery(() => listConnectorsAction(), [organization?.id]);

  // 操作の表示名・説明・影響は、連携サービスに登録した内容をそのまま使う
  const tools = useMemo(() => {
    const map = new Map<string, { tool: ToolDto; connectorName: string | null; description: string | null }>();
    for (const connector of connectors.data ?? []) {
      for (const tool of connector.tools) {
        const spec = tool.versions?.find((version) => version.version === tool.latest_version)?.spec;
        const description = spec && "description" in spec ? String(spec.description) : null;
        map.set(tool.name, { tool, connectorName: connector.name, description });
      }
    }
    return map;
  }, [connectors.data]);

  const steps = useMemo(() => buildRunSteps(events, { tools }), [events, tools]);
  const approvalById = useMemo(() => new Map(approvals.map((approval) => [approval.id, approval])), [approvals]);

  let actionIndex = 0;

  return (
    <Card aria-labelledby={`${endId}-title`}>
      <CardHeader
        title={<span id={`${endId}-title`}>経過</span>}
        description="エージェントが行ったことを、順番に表示します。"
        actions={
          steps.length >= JUMP_LINK_THRESHOLD ? (
            <a
              href={`#${endId}-end`}
              className="inline-flex items-center gap-1 rounded text-sm font-medium text-accent-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
            >
              <ArrowDownToLine className="h-4 w-4" aria-hidden="true" />
              最新へ移動
            </a>
          ) : null
        }
      />
      {steps.length === 0 ? (
        <EmptyState icon={Clock} title={finished ? "表示できる手順はありません" : "エージェントが動き出すのを待っています"} />
      ) : (
        <ol className="px-4 pb-4 sm:px-5">
          {steps.map((step, i) => {
            const isLast = i === steps.length - 1;
            // 最後のステップが終わっていなければ、それが今動いているところ
            const active = running && isLast;
            switch (step.kind) {
              case "instruction":
                return (
                  <StepShell
                    key={i}
                    index={null}
                    at={step.at}
                    tone="bg-gray-100 text-gray-500"
                    icon={<User className="h-4 w-4" aria-hidden="true" />}
                    title="あなたの指示"
                    isLast={isLast}
                  >
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-700">{step.text}</p>
                  </StepShell>
                );
              case "message":
                return (
                  <StepShell
                    key={i}
                    index={null}
                    at={step.at}
                    tone="bg-accent-50 text-accent-600"
                    icon={<MessageSquare className="h-4 w-4" aria-hidden="true" />}
                    title="エージェントの説明"
                    isLast={isLast}
                  >
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-700">{step.text}</p>
                  </StepShell>
                );
              case "environment":
                return (
                  <StepShell
                    key={i}
                    index={null}
                    at={step.at}
                    tone={step.done ? "bg-gray-100 text-gray-500" : "bg-sky-50 text-sky-600"}
                    icon={step.done ? <Server className="h-4 w-4" aria-hidden="true" /> : <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                    title="実行環境を用意しています"
                    badge={step.done ? <Badge tone="neutral">用意できました</Badge> : <Badge tone="info">準備中</Badge>}
                    isLast={isLast}
                  >
                    <p className="mt-0.5 text-xs text-gray-500">{step.detail}</p>
                  </StepShell>
                );
              case "error":
                return (
                  <StepShell
                    key={i}
                    index={null}
                    at={step.at}
                    tone="bg-red-50 text-red-600"
                    icon={<CircleAlert className="h-4 w-4" aria-hidden="true" />}
                    title="エラー"
                    isLast={isLast}
                  >
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-red-900">{step.text}</p>
                  </StepShell>
                );
              case "action": {
                actionIndex += 1;
                return (
                  <ActionStep
                    key={i}
                    step={step}
                    index={actionIndex}
                    isLast={isLast}
                    active={active}
                    finished={finished}
                    approval={step.approvalId ? approvalById.get(step.approvalId) : undefined}
                    canDecide={can("approval.decide")}
                    onDecided={onApprovalDecided}
                  />
                );
              }
            }
          })}
          {running && steps.every((step) => step.kind !== "environment" || step.done) ? (
            <li className="relative flex gap-3">
              <span className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-50 text-accent-600">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              </span>
              <p className="pt-2 text-sm text-gray-500">エージェントが次にすることを考えています</p>
            </li>
          ) : null}
        </ol>
      )}
      <span id={`${endId}-end`} />
    </Card>
  );
}
