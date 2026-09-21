import type { BuilderProjectStatus } from "@agent-studio/contracts";
import { Badge } from "@/components/ui/badge";
import type { Tone } from "@/lib/utils/labels";

const labels: Record<BuilderProjectStatus, string> = {
  draft: "開始待ち",
  analyzing: "依頼を整理中",
  discovering: "連携方法を調査中",
  planning: "実装計画を作成済み",
  waiting_human_action: "準備待ち",
  implementing: "実装中",
  validating: "テスト中",
  previewing: "Preview確認中",
  ready_for_production: "本番公開の準備完了",
  production_pending_approval: "本番承認待ち",
  completed: "完了",
  blocked: "続行不可",
  failed: "失敗",
  cancelled: "中止",
};

const tone = (status: BuilderProjectStatus): Tone => {
  if (["completed", "ready_for_production"].includes(status)) return "success";
  if (["failed", "blocked", "cancelled"].includes(status)) return "danger";
  if (status === "waiting_human_action" || status === "production_pending_approval") return "warning";
  if (["draft", "planning"].includes(status)) return "neutral";
  return "info";
};

export function BuilderProjectStatusBadge({ status }: { status: BuilderProjectStatus }) {
  const active = ["analyzing", "discovering", "implementing", "validating", "previewing"].includes(status);
  return <Badge tone={tone(status)} dot pulse={active}>{labels[status]}</Badge>;
}

export function builderProjectStatusLabel(status: BuilderProjectStatus) { return labels[status]; }
