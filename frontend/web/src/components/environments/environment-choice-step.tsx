"use client";

import { Building2, Cloud, Server, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RadioCards, type RadioCardOption } from "@/components/ui/radio-cards";
import { cn } from "@/lib/utils/cn";
import { CHOICE_LABELS } from "./environment-review";
import type { EnvironmentChoice } from "./environment-wizard";

type MainChoice = Exclude<EnvironmentChoice, "none">;

const CHOICE_OPTIONS: RadioCardOption<MainChoice>[] = [
  {
    value: "openai_hosted",
    label: CHOICE_LABELS.openai_hosted,
    description: "OpenAI が用意する安全な環境で動かします。すぐに使えます",
    icon: Cloud,
  },
  {
    value: "studio_managed",
    label: CHOICE_LABELS.studio_managed,
    description: "Agent Studio が御社専用に用意した AWS アカウントで動かします",
    icon: Server,
  },
  {
    value: "customer_owned",
    label: CHOICE_LABELS.customer_owned,
    description: "御社の AWS アカウントに実行環境を作ります。社内システムの認証情報を外に出さずに使えます",
    icon: Building2,
  },
];

export interface EnvironmentChoiceStepProps {
  value: EnvironmentChoice | null;
  onChange: (choice: EnvironmentChoice) => void;
  error?: string;
}

/** 手順 1: どこで実行するか */
export function EnvironmentChoiceStep({ value, onChange, error }: EnvironmentChoiceStepProps) {
  const noneSelected = value === "none";
  return (
    <div className="space-y-5">
      <RadioCards
        legend="どこで実行しますか？"
        description="あとから別の実行環境を追加することもできます。"
        options={CHOICE_OPTIONS}
        value={value === "none" ? null : value}
        onChange={onChange}
        columns={3}
        error={error}
      />
      <div
        className={cn(
          "flex flex-col gap-3 rounded-xl border border-dashed px-4 py-3 sm:flex-row sm:items-center sm:justify-between",
          noneSelected ? "border-accent-500 bg-accent-50/50" : "border-gray-300",
        )}
      >
        <p className="flex items-start gap-2 text-sm text-gray-600">
          <Wrench className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
          プログラムの実行やファイルの操作をせず、登録したツールだけを使うエージェントの場合は、実行環境は必要ありません。
        </p>
        <Button variant={noneSelected ? "primary" : "secondary"} size="sm" aria-pressed={noneSelected} onClick={() => onChange("none")}>
          実行環境を使わない（ツールだけを使う）
        </Button>
      </div>
    </div>
  );
}
