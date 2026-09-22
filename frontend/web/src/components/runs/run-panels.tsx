"use client";

import type { RunDto } from "@agent-studio/contracts";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { RunStatusBadge, StageBadge } from "@/components/common/status-badges";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { DescriptionList } from "@/components/ui/description-list";
import { formatDateTime, formatDuration, formatNumber } from "@/lib/utils/format";
import { PROFILE_TYPE_LABELS } from "@/lib/utils/labels";
import { RunOutput } from "./run-output";
import { isTerminalRunStatus } from "./use-run-stream";

/** 指示・結果など、長い文章を表示するカード */
export function RunTextPanel({
  title,
  text,
  placeholder,
  actions,
  format = "plain",
}: {
  title: string;
  text: string | null;
  placeholder: ReactNode;
  actions?: ReactNode;
  format?: "plain" | "rich";
}) {
  return (
    <Card>
      <CardHeader title={title} actions={actions} />
      <CardBody>
        {text ? (
          format === "rich" ? (
            <RunOutput output={text} />
          ) : (
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-900">{text}</p>
          )
        ) : (
          <div className="text-sm text-gray-500">{placeholder}</div>
        )}
      </CardBody>
    </Card>
  );
}

/** 結果が出るまでの表示 */
export function RunOutputPlaceholder({ run }: { run: RunDto }) {
  if (isTerminalRunStatus(run.status)) {
    return <p>{run.status === "completed" ? "結果の文章はありません。" : "結果は出ていません。"}</p>;
  }
  return (
    <p className="inline-flex items-center gap-2">
      <Loader2 className="h-4 w-4 animate-spin text-gray-400" aria-hidden="true" />
      {run.status === "waiting_approval"
        ? "承認を待っています。承認されると作業を続けます。"
        : "エージェントが作業しています。終わると、結果がここに表示されます。"}
    </p>
  );
}

function durationText(run: RunDto): string {
  if (run.finished_at) return formatDuration(run.started_at ?? run.created_at, run.finished_at);
  if (isTerminalRunStatus(run.status)) return "—";
  return run.started_at ? "実行中" : "開始待ち";
}

/** 実行の情報（環境・日時・利用量など） */
export function RunInfoCard({ run }: { run: RunDto }) {
  return (
    <Card>
      <CardHeader title="実行の情報" />
      <CardBody>
        <DescriptionList
          columns={1}
          items={[
            { label: "状態", value: <RunStatusBadge status={run.status} outcome={run.outcome} /> },
            {
              label: "実行環境",
              value: (
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{run.runtime_profile.name}</span>
                    <StageBadge stage={run.deployment.stage} />
                  </div>
                  <p className="text-xs text-gray-500">{PROFILE_TYPE_LABELS[run.runtime_profile.type]}</p>
                </div>
              ),
            },
            { label: "実行した人", value: run.requested_by_email ?? run.requested_by ?? "—" },
            { label: "受け付けた日時", value: formatDateTime(run.created_at) },
            { label: "開始した日時", value: formatDateTime(run.started_at) },
            { label: "終了した日時", value: formatDateTime(run.finished_at) },
            { label: "所要時間", value: durationText(run) },
            {
              label: "利用したトークン",
              value: run.usage ? (
                <div className="space-y-0.5">
                  <p>入力 {formatNumber(run.usage.input_tokens)}</p>
                  <p>出力 {formatNumber(run.usage.output_tokens)}</p>
                </div>
              ) : (
                "—"
              ),
            },
            {
              label: "実行 ID",
              value: (
                <div className="flex items-center gap-1">
                  <span className="min-w-0 break-all font-mono text-xs text-gray-700">{run.id}</span>
                  <CopyButton value={run.id} label="コピー" />
                </div>
              ),
            },
          ]}
        />
      </CardBody>
    </Card>
  );
}
