import type { Prisma } from "@prisma/client";
import type { RunEventType, RunStatus } from "@agent-studio/contracts";
import type { Tx } from "../infrastructure/db/tenant-db.js";

/** 実行のタイムラインにイベントを追加する（seq は Run ごとの連番） */
export async function appendRunEvent(
  tx: Tx,
  run: { id: string; organization_id: string },
  type: RunEventType,
  summary: string,
  data: unknown = {},
): Promise<number> {
  const { last_event_seq: seq } = await tx.runs.update({
    where: { id: run.id },
    data: { last_event_seq: { increment: 1 } },
    select: { last_event_seq: true },
  });
  await tx.run_events.createMany({
    data: [
      {
        organization_id: run.organization_id,
        run_id: run.id,
        seq,
        type,
        summary: summary.slice(0, 1000),
        data: (data ?? {}) as Prisma.InputJsonValue,
      },
    ],
  });
  return seq;
}

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: "実行待ち",
  provisioning: "実行環境を準備中",
  running: "実行中",
  waiting_approval: "承認待ち",
  waiting_input: "返答を待っています",
  requires_action: "処理待ち",
  completed: "完了",
  failed: "失敗",
  cancelled: "中止",
};

/** Run の状態を変え、タイムラインに記録する */
export async function setRunStatus(
  tx: Tx,
  run: { id: string; organization_id: string },
  status: RunStatus,
  extra: Prisma.runsUpdateInput = {},
  detail?: string,
): Promise<void> {
  const terminal = status === "completed" || status === "failed" || status === "cancelled";
  await tx.runs.update({
    where: { id: run.id },
    data: {
      status,
      ...(status === "failed" ? { outcome: "failed" } : {}),
      ...(status === "cancelled" ? { outcome: "cancelled" } : {}),
      ...(status === "running" ? { started_at: undefined } : {}),
      ...(terminal ? { finished_at: new Date(), stream_lease_owner: null, stream_lease_until: null } : {}),
      ...extra,
    },
  });
  await appendRunEvent(tx, run, "run.status", detail ? `${RUN_STATUS_LABELS[status]}: ${detail}` : RUN_STATUS_LABELS[status], {
    status,
  });
}
