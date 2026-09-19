"use client";

import type { ProvisioningType, RuntimeDto, Stage } from "@agent-studio/contracts";
import { FlaskConical, Plus, Rocket, Server } from "lucide-react";
import { RuntimeStatusBadge, StageBadge } from "@/components/common/status-badges";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { RadioCards, type RadioCardOption } from "@/components/ui/radio-cards";
import { PROVISIONING_TYPE_LABELS, STAGE_LABELS } from "@/lib/utils/labels";
import type { EnvironmentWizardState, RuntimeMode } from "./environment-wizard";
import { expectedRoleName } from "./runtime-secrets";

const STAGE_OPTIONS: RadioCardOption<Stage>[] = [
  { value: "staging", label: STAGE_LABELS.staging, description: "テストや動作の確認に使います", icon: FlaskConical },
  { value: "production", label: STAGE_LABELS.production, description: "実際の業務で使います", icon: Rocket },
];

export interface AwsRuntimeFieldsProps {
  provisioningType: ProvisioningType;
  state: EnvironmentWizardState;
  update: (patch: Partial<EnvironmentWizardState>) => void;
  errors: Record<string, string>;
  /** 組織の Runtime（読み込み中は undefined） */
  runtimes: RuntimeDto[] | undefined;
  runtimesFailed: boolean;
  disabled?: boolean;
}

/** AWS で実行するときの設定（既存の Runtime を使うか、新しく作るか） */
export function AwsRuntimeFields({
  provisioningType,
  state,
  update,
  errors,
  runtimes,
  runtimesFailed,
  disabled = false,
}: AwsRuntimeFieldsProps) {
  const candidates = (runtimes ?? []).filter((r) => r.provisioning_type === provisioningType && r.status !== "revoked");
  const selected = candidates.find((r) => r.id === state.runtimeId);
  const noCandidates = !!runtimes && candidates.length === 0;

  const modeOptions: RadioCardOption<RuntimeMode>[] = [
    {
      value: "existing",
      label: "既存の Runtime を使う",
      description: !runtimes
        ? runtimesFailed
          ? "Runtime の一覧を読み込めませんでした"
          : "Runtime の一覧を読み込んでいます…"
        : noCandidates
          ? `「${PROVISIONING_TYPE_LABELS[provisioningType]}」の Runtime はまだありません`
          : `作成済みの Runtime（${candidates.length} 件）から選びます`,
      icon: Server,
      disabled: disabled || candidates.length === 0,
    },
    {
      value: "new",
      label: "新しく作る",
      description: "AWS アカウントの情報を登録して、新しい Runtime を作ります",
      icon: Plus,
      disabled,
    },
  ];

  const setStage = (stage: Stage) => {
    const tenant = state.tenantShort.trim();
    update(tenant ? { stage, roleName: expectedRoleName(tenant, stage) } : { stage });
  };

  const setTenant = (tenantShort: string) => {
    const tenant = tenantShort.trim();
    update(tenant ? { tenantShort, roleName: expectedRoleName(tenant, state.stage) } : { tenantShort });
  };

  return (
    <div className="space-y-6">
      <RadioCards
        legend="どの Runtime を使いますか？"
        description="Runtime は、AWS アカウントの中で実際にエージェントを動かす仕組みです。1 つの Runtime を複数の実行環境で使えます。"
        options={modeOptions}
        value={state.runtimeMode}
        onChange={(runtimeMode) => update({ runtimeMode })}
        columns={2}
      />

      {state.runtimeMode === "existing" ? (
        <Field label="使う Runtime" required error={errors.runtime_id}>
          <Select value={state.runtimeId} onChange={(e) => update({ runtimeId: e.target.value })} disabled={disabled || candidates.length === 0}>
            <option value="">選んでください</option>
            {candidates.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}（{STAGE_LABELS[r.stage]}・{r.aws_account_id}）
              </option>
            ))}
          </Select>
          {selected ? (
            <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-gray-500">
              <StageBadge stage={selected.stage} />
              <RuntimeStatusBadge status={selected.status} />
              <span>
                {selected.aws_region}・<span className="font-mono">{selected.expected_role_name}</span>
              </span>
            </div>
          ) : null}
        </Field>
      ) : (
        <div className="space-y-5">
          <Field label="Runtime の名前" required error={errors["runtime.name"]} hint="一覧に表示する名前です（例: 本番用 Runtime）。">
            <Input
              value={state.runtimeName}
              maxLength={100}
              onChange={(e) => update({ runtimeName: e.target.value })}
              disabled={disabled}
              autoComplete="off"
            />
          </Field>

          <RadioCards
            legend="どちらの環境ですか？"
            description="検証用と本番は別の Runtime に分けます。"
            options={STAGE_OPTIONS.map((o) => ({ ...o, disabled }))}
            value={state.stage}
            onChange={setStage}
            columns={2}
            error={errors["runtime.stage"]}
          />

          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="AWS アカウント ID"
              required
              error={errors["runtime.aws_account_id"]}
              hint={
                provisioningType === "studio_managed"
                  ? "Agent Studio が御社専用に用意した AWS アカウントの ID（12 桁の数字）です。"
                  : "実行環境を作る、御社の AWS アカウントの ID（12 桁の数字）です。"
              }
            >
              <Input
                value={state.awsAccountId}
                onChange={(e) => update({ awsAccountId: e.target.value.replace(/[^\d]/g, "") })}
                inputMode="numeric"
                maxLength={12}
                placeholder="123456789012"
                className="font-mono"
                autoComplete="off"
                disabled={disabled}
              />
            </Field>
            <Field label="リージョン" required error={errors["runtime.aws_region"]} hint="通常は東京リージョン（ap-northeast-1）のままで構いません。">
              <Input
                value={state.awsRegion}
                onChange={(e) => update({ awsRegion: e.target.value })}
                className="font-mono"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                disabled={disabled}
              />
            </Field>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="テナントの短い名前"
              optional
              hint="入力すると、IAM ロール名を自動で入れます（Terraform の config.yaml の short_name です）。"
            >
              <Input
                value={state.tenantShort}
                onChange={(e) => setTenant(e.target.value)}
                placeholder="sample-a"
                className="font-mono"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                disabled={disabled}
              />
            </Field>
            <Field
              label="IAM ロール名"
              required
              error={errors["runtime.expected_role_name"]}
              hint="Terraform が作るロール名は as-<テナントの短い名前>-<prod|stg>-runtime です（例: as-sample-a-prod-runtime）。登録のときに、このロールからの接続かどうかを確認します。"
            >
              <Input
                value={state.roleName}
                onChange={(e) => update({ roleName: e.target.value })}
                placeholder={expectedRoleName("sample-a", state.stage)}
                className="font-mono"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                disabled={disabled}
              />
            </Field>
          </div>
        </div>
      )}
    </div>
  );
}
