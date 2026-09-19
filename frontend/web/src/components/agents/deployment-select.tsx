"use client";

import type { DeploymentDto } from "@agent-studio/contracts";
import type { ReactNode } from "react";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/input";
import { STAGE_LABELS } from "@/lib/utils/labels";

/** エージェントの詳細画面のタブ */
export type AgentTab = "overview" | "definition" | "deploy" | "run" | "eval";
export const AGENT_TABS: readonly AgentTab[] = ["overview", "definition", "deploy", "run", "eval"];

/** 例: v3・価格変更用 AWS・検証用 */
export function deploymentLabel(d: Pick<DeploymentDto, "agent_version" | "runtime_profile" | "stage">): string {
  return `v${d.agent_version}・${d.runtime_profile.name}・${STAGE_LABELS[d.stage]}`;
}

/** 稼働中のデプロイ（誤って本番で実行しないよう検証用を先に。同じ環境なら新しい順） */
export function activeDeployments(deployments: readonly DeploymentDto[] | undefined): DeploymentDto[] {
  return (deployments ?? [])
    .filter((d) => d.status === "active")
    .sort((a, b) => (a.stage === b.stage ? b.created_at.localeCompare(a.created_at) : a.stage === "staging" ? -1 : 1));
}

export function DeploymentSelect({
  deployments,
  value,
  onChange,
  label = "どのデプロイを使いますか？",
  hint,
  disabled,
}: {
  deployments: readonly DeploymentDto[];
  value: string;
  onChange: (id: string) => void;
  label?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        {deployments.map((d) => (
          <option key={d.id} value={d.id}>
            {deploymentLabel(d)}
          </option>
        ))}
      </Select>
    </Field>
  );
}
