"use client";

import type { RuntimeDto } from "@agent-studio/contracts";
import { StageBadge } from "@/components/common/status-badges";
import { DescriptionList, type DescriptionItem } from "@/components/ui/description-list";
import { NETWORK_MODE_LABELS, OPENAI_TEMPLATE_LABELS, PROFILE_TYPE_LABELS, PROVISIONING_TYPE_LABELS } from "@/lib/utils/labels";
import { domainLines, isAwsChoice, type EnvironmentChoice, type EnvironmentWizardState } from "./environment-wizard";

export const CHOICE_LABELS: Record<EnvironmentChoice, string> = {
  openai_hosted: "OpenAIの環境で実行",
  studio_managed: "Agent Studioが用意するAWSで実行",
  customer_owned: "自社のAWSアカウントで実行",
  none: PROFILE_TYPE_LABELS.none,
};

function Mono({ children }: { children: string }) {
  return <span className="break-all font-mono text-[13px]">{children}</span>;
}

/** 作成する前の確認用の一覧 */
export function EnvironmentReview({ state, runtimes }: { state: EnvironmentWizardState; runtimes: RuntimeDto[] | undefined }) {
  if (!state.choice) return null;
  const items: DescriptionItem[] = [
    { label: "実行する場所", value: CHOICE_LABELS[state.choice], wide: true },
    { label: "名前", value: state.name.trim() },
    { label: "キー", value: <Mono>{state.key.trim()}</Mono> },
  ];

  if (state.choice === "openai_hosted") {
    const domains = domainLines(state.allowedDomains);
    items.push(
      { label: "作業の種類", value: OPENAI_TEMPLATE_LABELS[state.template] },
      { label: "インターネットへの接続", value: NETWORK_MODE_LABELS[state.networkMode] },
    );
    if (state.networkMode === "restricted") {
      items.push({
        label: `接続を許可するドメイン（${domains.length} 件）`,
        value: (
          <ul className="flex flex-wrap gap-1.5">
            {domains.map((d) => (
              <li key={d} className="rounded-md bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-800">
                {d}
              </li>
            ))}
          </ul>
        ),
        wide: true,
      });
    }
  }

  if (isAwsChoice(state.choice)) {
    if (state.runtimeMode === "existing") {
      const runtime = runtimes?.find((r) => r.id === state.runtimeId);
      items.push({
        label: "使う Runtime",
        value: runtime ? (
          <span className="inline-flex flex-wrap items-center gap-2">
            {runtime.name}
            <StageBadge stage={runtime.stage} />
          </span>
        ) : (
          "—"
        ),
        wide: true,
      });
    } else {
      items.push(
        { label: "Runtime", value: `新しく作る（${PROVISIONING_TYPE_LABELS[state.choice]}）`, wide: true },
        { label: "Runtime の名前", value: state.runtimeName.trim() },
        { label: "環境", value: <StageBadge stage={state.stage} /> },
        { label: "リージョン", value: <Mono>{state.awsRegion.trim()}</Mono> },
      );
      if (state.choice === "customer_owned") {
        items.push(
          { label: "AWS アカウント ID", value: <Mono>{state.awsAccountId.trim()}</Mono> },
          { label: "IAM ロール名", value: <Mono>{state.roleName.trim()}</Mono>, wide: true },
        );
      } else {
        items.push({ label: "構築", value: "AWSアカウントとRuntimeを自動で用意します", wide: true });
      }
    }
  }

  return <DescriptionList items={items} columns={2} />;
}
