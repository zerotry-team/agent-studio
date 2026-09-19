"use client";

import { runStatusSchema, type RunEventDto, type RunEventType } from "@agent-studio/contracts";
import {
  Activity,
  ArrowDownToLine,
  Braces,
  ChevronRight,
  CircleAlert,
  Clock,
  CornerDownRight,
  Gauge,
  MessageSquare,
  Server,
  ShieldAlert,
  ShieldCheck,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useId, useState } from "react";
import { RunStatusBadge } from "@/components/common/status-badges";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { JsonView } from "@/components/ui/code-block";
import { EmptyState } from "@/components/ui/empty-state";
import { Checkbox } from "@/components/ui/input";
import { cn } from "@/lib/utils/cn";
import { formatNumber, formatTime } from "@/lib/utils/format";
import { RUN_EVENT_LABELS } from "@/lib/utils/labels";

const EVENT_ICONS: Record<RunEventType, { icon: LucideIcon; className: string }> = {
  "run.status": { icon: Activity, className: "bg-sky-50 text-sky-600" },
  "environment.status": { icon: Server, className: "bg-gray-100 text-gray-500" },
  message: { icon: MessageSquare, className: "bg-accent-50 text-accent-600" },
  "tool.call": { icon: Wrench, className: "bg-gray-100 text-gray-600" },
  "tool.result": { icon: CornerDownRight, className: "bg-gray-100 text-gray-600" },
  "approval.requested": { icon: ShieldAlert, className: "bg-amber-50 text-amber-600" },
  "approval.decided": { icon: ShieldCheck, className: "bg-emerald-50 text-emerald-600" },
  usage: { icon: Gauge, className: "bg-gray-100 text-gray-500" },
  error: { icon: CircleAlert, className: "bg-red-50 text-red-600" },
  "openai.event": { icon: Braces, className: "bg-gray-100 text-gray-400" },
};

/** 経過を折りたたまずに並べる件数の目安（これより多いと「最新へ移動」を出す） */
const JUMP_LINK_THRESHOLD = 6;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function pickString(record: Record<string, unknown> | null, ...keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const v = record[key];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

function pickNumber(record: Record<string, unknown> | null, key: string): number | null {
  const v = record?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function hasDetail(data: unknown): boolean {
  if (data === null || data === undefined) return false;
  if (typeof data === "string") return data.trim() !== "";
  if (Array.isArray(data)) return data.length > 0;
  if (typeof data === "object") return Object.keys(data as object).length > 0;
  return true;
}

function Summary({ children, className }: { children: string; className?: string }) {
  if (!children) return null;
  return <p className={cn("whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-700", className)}>{children}</p>;
}

function MessageBody({ event }: { event: RunEventDto }) {
  const data = asRecord(event.data);
  const text = pickString(data, "text", "content") ?? event.summary;
  const fromUser = pickString(data, "role") === "user";
  return (
    <div
      className={cn(
        "max-w-full whitespace-pre-wrap break-words rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm leading-relaxed sm:max-w-[90%]",
        fromUser ? "bg-gray-100 text-gray-800" : "border border-accent-100 bg-accent-50/60 text-gray-900",
      )}
    >
      {text || "（内容はありません）"}
    </div>
  );
}

function ToolCallBody({ event }: { event: RunEventDto }) {
  const data = asRecord(event.data);
  const tool = pickString(data, "tool", "name", "tool_name");
  const args = data ? (data.args ?? data.arguments ?? data.input) : undefined;
  const command = pickString(data, "command");
  const error = pickString(data, "error");
  return (
    <div className="space-y-2">
      {tool ? (
        <p>
          <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[13px] font-semibold text-gray-900">{tool}</code>
        </p>
      ) : null}
      <Summary>{event.summary}</Summary>
      {command ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-gray-900 px-3 py-2 font-mono text-xs text-gray-100">{command}</pre>
      ) : null}
      {error ? <p className="whitespace-pre-wrap break-words text-sm text-red-700">{error}</p> : null}
      {args !== undefined && hasDetail(args) ? (
        <div>
          <p className="text-xs font-medium text-gray-500">引数</p>
          <JsonView value={args} className="mt-1" maxHeight="12rem" />
        </div>
      ) : null}
    </div>
  );
}

function ToolResultBody({ event }: { event: RunEventDto }) {
  const data = asRecord(event.data);
  const tool = pickString(data, "tool", "name", "tool_name");
  return (
    <div className="space-y-1.5">
      {tool ? (
        <p>
          <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[13px] text-gray-800">{tool}</code>
        </p>
      ) : null}
      <Summary>{event.summary}</Summary>
    </div>
  );
}

function ApprovalRequestedBody({ event }: { event: RunEventDto }) {
  const data = asRecord(event.data);
  const tool = pickString(data, "tool", "tool_name");
  const preview = pickString(data, "args_preview");
  let args: unknown = preview;
  if (preview) {
    try {
      args = JSON.parse(preview);
    } catch {
      args = preview;
    }
  }
  return (
    <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
      {tool ? <p className="font-mono text-[13px] font-semibold">{tool}</p> : null}
      <p className="whitespace-pre-wrap break-words leading-relaxed">{event.summary || "承認を待っています"}</p>
      {preview ? (
        <div>
          <p className="text-xs font-medium text-amber-800">実行しようとしている内容</p>
          <JsonView value={args} className="mt-1" maxHeight="12rem" />
        </div>
      ) : null}
    </div>
  );
}

function ApprovalDecidedBody({ event }: { event: RunEventDto }) {
  const data = asRecord(event.data);
  const decision = pickString(data, "decision", "status");
  const approved = decision === "approve" || decision === "approved";
  const denied = decision === "deny" || decision === "denied";
  const expired = decision === "expired";
  return (
    <div className="flex flex-wrap items-start gap-2">
      {approved ? <Badge tone="success">承認</Badge> : denied ? <Badge tone="danger">却下</Badge> : expired ? <Badge tone="neutral">期限切れ</Badge> : null}
      <Summary className="min-w-0 flex-1">{event.summary}</Summary>
    </div>
  );
}

function RunStatusBody({ event }: { event: RunEventDto }) {
  const parsed = runStatusSchema.safeParse(pickString(asRecord(event.data), "status", "to"));
  return (
    <div className="flex flex-wrap items-start gap-2">
      {parsed.success ? <RunStatusBadge status={parsed.data} /> : null}
      <Summary className="min-w-0 flex-1 text-gray-600">{event.summary}</Summary>
    </div>
  );
}

function UsageBody({ event }: { event: RunEventDto }) {
  const data = asRecord(event.data);
  const input = pickNumber(data, "input_tokens");
  const output = pickNumber(data, "output_tokens");
  return (
    <div className="space-y-1">
      <Summary className="text-gray-600">{event.summary}</Summary>
      {input !== null || output !== null ? (
        <p className="text-xs text-gray-500">
          入力 {formatNumber(input)} トークン・出力 {formatNumber(output)} トークン
        </p>
      ) : null}
    </div>
  );
}

function ErrorBody({ event }: { event: RunEventDto }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900">
      <p className="whitespace-pre-wrap break-words leading-relaxed">{event.summary || "エラーが発生しました"}</p>
    </div>
  );
}

function EventBody({ event }: { event: RunEventDto }) {
  switch (event.type) {
    case "message":
      return <MessageBody event={event} />;
    case "tool.call":
      return <ToolCallBody event={event} />;
    case "tool.result":
      return <ToolResultBody event={event} />;
    case "approval.requested":
      return <ApprovalRequestedBody event={event} />;
    case "approval.decided":
      return <ApprovalDecidedBody event={event} />;
    case "run.status":
      return <RunStatusBody event={event} />;
    case "usage":
      return <UsageBody event={event} />;
    case "error":
      return <ErrorBody event={event} />;
    case "openai.event":
      return <Summary className="font-mono text-xs text-gray-500">{event.summary}</Summary>;
    case "environment.status":
    default:
      return <Summary className="text-gray-600">{event.summary}</Summary>;
  }
}

function roleLabel(event: RunEventDto): string | null {
  if (event.type !== "message") return null;
  const role = pickString(asRecord(event.data), "role");
  if (role === "user") return "指示";
  if (role === "assistant") return "エージェント";
  return null;
}

function RunEventItem({ event, isLast }: { event: RunEventDto; isLast: boolean }) {
  const { icon: Icon, className } = EVENT_ICONS[event.type];
  const role = roleLabel(event);
  return (
    <li className="relative flex gap-3 pb-6 last:pb-0">
      {!isLast ? <span className="absolute bottom-0 left-4 top-9 w-px -translate-x-1/2 bg-gray-200" aria-hidden="true" /> : null}
      <span
        className={cn("relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-4 ring-white", className)}
        aria-hidden="true"
      >
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1 pt-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <p className="text-sm font-medium text-gray-900">
            {RUN_EVENT_LABELS[event.type]}
            {role ? <span className="ml-2 text-xs font-normal text-gray-500">{role}</span> : null}
          </p>
          <time dateTime={event.created_at} className="text-xs tabular-nums text-gray-500">
            {formatTime(event.created_at)}
          </time>
        </div>
        <div className="mt-1.5">
          <EventBody event={event} />
        </div>
        {hasDetail(event.data) ? (
          <details className="group mt-2">
            <summary className="inline-flex cursor-pointer select-none list-none items-center gap-1 rounded text-xs font-medium text-gray-500 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 [&::-webkit-details-marker]:hidden">
              <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
              詳しいデータ
            </summary>
            <JsonView value={event.data} className="mt-2" maxHeight="20rem" />
          </details>
        ) : null}
      </div>
    </li>
  );
}

export interface RunEventTimelineProps {
  events: RunEventDto[];
  /** 実行が終わっているか（空のときの表示を変える） */
  finished: boolean;
}

/** 実行の経過（古い順。最新は一番下） */
export function RunEventTimeline({ events, finished }: RunEventTimelineProps) {
  const [showDetailed, setShowDetailed] = useState(false);
  const endId = useId();
  const visible = showDetailed ? events : events.filter((e) => e.type !== "openai.event");
  const detailedCount = events.length - events.filter((e) => e.type !== "openai.event").length;

  return (
    <Card aria-labelledby={`${endId}-title`}>
      <CardHeader
        title={<span id={`${endId}-title`}>経過</span>}
        description="エージェントが行ったことを、古い順に表示します。"
        actions={
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Checkbox
              label={detailedCount > 0 ? `詳細なイベントも表示する（${detailedCount}件）` : "詳細なイベントも表示する"}
              checked={showDetailed}
              onChange={(e) => setShowDetailed(e.target.checked)}
            />
            {visible.length >= JUMP_LINK_THRESHOLD ? (
              <a
                href={`#${endId}-end`}
                className="inline-flex items-center gap-1 rounded text-sm font-medium text-accent-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
              >
                <ArrowDownToLine className="h-4 w-4" aria-hidden="true" />
                最新へ移動
              </a>
            ) : null}
          </div>
        }
      />
      {visible.length === 0 ? (
        <EmptyState
          icon={Clock}
          title={finished ? "表示できるイベントはありません" : "まだイベントはありません"}
          description={finished ? undefined : "実行が始まると、エージェントの経過がここに表示されます。"}
        />
      ) : (
        <div className="px-5 py-5">
          <ol aria-label="実行の経過" className="relative">
            {visible.map((event, i) => (
              <RunEventItem key={event.seq} event={event} isLast={i === visible.length - 1} />
            ))}
          </ol>
          <div id={`${endId}-end`} tabIndex={-1} className="scroll-mt-24 focus:outline-none">
            <span className="sr-only">経過の最後</span>
          </div>
        </div>
      )}
    </Card>
  );
}
