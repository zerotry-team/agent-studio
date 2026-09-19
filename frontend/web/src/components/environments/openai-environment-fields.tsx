"use client";

import type { NetworkPolicy, OpenAiTemplate } from "@agent-studio/contracts";
import { Globe, Lock, ShieldCheck } from "lucide-react";
import { Field } from "@/components/ui/field";
import { Select, Textarea } from "@/components/ui/input";
import { RadioCards, type RadioCardOption } from "@/components/ui/radio-cards";
import { NETWORK_MODE_LABELS, OPENAI_TEMPLATE_LABELS } from "@/lib/utils/labels";
import type { EnvironmentWizardState } from "./environment-wizard";

export const OPENAI_TEMPLATE_ORDER: readonly OpenAiTemplate[] = [
  "general-python",
  "browser-basic",
  "data-analysis",
  "document-processing",
];

export const OPENAI_TEMPLATE_DESCRIPTIONS: Record<OpenAiTemplate, string> = {
  "general-python": "Python を使ったデータの加工やファイルの作成など、一般的な作業に向いています",
  "browser-basic": "Web ページを開いて情報を集めるなど、ブラウザを使う作業に向いています",
  "data-analysis": "表データの集計やグラフの作成など、データの分析に向いています",
  "document-processing": "PDF や Word などの文書の読み取り・作成に向いています",
};

export const NETWORK_MODE_DESCRIPTIONS: Record<NetworkPolicy["mode"], string> = {
  disabled: "もっとも安全です。インターネット上の情報を使わない作業に向いています",
  restricted: "指定したドメインにだけ接続できます",
  enabled: "どこにでも接続できます。信頼できない内容を読み込む可能性があります",
};

const NETWORK_OPTIONS: RadioCardOption<NetworkPolicy["mode"]>[] = [
  { value: "disabled", label: NETWORK_MODE_LABELS.disabled, description: NETWORK_MODE_DESCRIPTIONS.disabled, icon: Lock },
  { value: "restricted", label: NETWORK_MODE_LABELS.restricted, description: NETWORK_MODE_DESCRIPTIONS.restricted, icon: ShieldCheck },
  { value: "enabled", label: NETWORK_MODE_LABELS.enabled, description: NETWORK_MODE_DESCRIPTIONS.enabled, icon: Globe },
];

export interface OpenAiEnvironmentFieldsProps {
  state: EnvironmentWizardState;
  update: (patch: Partial<EnvironmentWizardState>) => void;
  errors: Record<string, string>;
  disabled?: boolean;
}

/** OpenAI の環境で実行するときの設定（作業の種類とインターネットへの接続） */
export function OpenAiEnvironmentFields({ state, update, errors, disabled = false }: OpenAiEnvironmentFieldsProps) {
  return (
    <div className="space-y-6">
      <Field label="どんな作業をさせますか？" required error={errors.template} hint={OPENAI_TEMPLATE_DESCRIPTIONS[state.template]}>
        <Select
          value={state.template}
          onChange={(e) => update({ template: e.target.value as OpenAiTemplate })}
          disabled={disabled}
        >
          {OPENAI_TEMPLATE_ORDER.map((template) => (
            <option key={template} value={template}>
              {OPENAI_TEMPLATE_LABELS[template]}
            </option>
          ))}
        </Select>
      </Field>

      <RadioCards
        legend="インターネットへの接続をどうしますか？"
        options={NETWORK_OPTIONS.map((o) => ({ ...o, disabled }))}
        value={state.networkMode}
        onChange={(networkMode) => update({ networkMode })}
        columns={3}
        error={errors["network.mode"] ?? errors.network}
      />

      {state.networkMode === "restricted" ? (
        <Field
          label="接続を許可するドメイン"
          required
          error={errors["network.allowed_domains"]}
          hint="1 行に 1 つずつ、ホスト名だけを書きます（https:// や / は付けません）。最大 100 件です。"
        >
          <Textarea
            mono
            rows={5}
            value={state.allowedDomains}
            onChange={(e) => update({ allowedDomains: e.target.value })}
            placeholder={"api.example.com\nwww.example.co.jp"}
            disabled={disabled}
            autoComplete="off"
            autoCapitalize="off"
          />
        </Field>
      ) : null}
    </div>
  );
}
