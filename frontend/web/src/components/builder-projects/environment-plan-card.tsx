"use client";

import type { EnvironmentPlanDto } from "@agent-studio/contracts";
import { ChevronDown, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";

const LOCATION_LABELS: Record<EnvironmentPlanDto["execution_location"], string> = {
  model: "安全なクラウド環境（AIモデルのみ）",
  studio: "安全なクラウド環境",
  runtime: "貴社専用の実行環境（貴社AWS内）",
};

const TEMPLATE_LABELS: Record<string, string> = {
  "general-python": "標準",
  "browser-basic": "ブラウザ",
  "data-analysis": "データ集計",
  "document-processing": "文書処理",
};

/**
 * Builder Agent が選んだ構成を読み取り専用で見せる。
 * 利用者に「実行環境」を選ばせないので、ここには入力欄を置かない。技術的な内訳は畳んでおく。
 */
export function EnvironmentPlanCard({ plan, compact = false }: { plan: EnvironmentPlanDto; compact?: boolean }) {
  const egress = plan.egress.length ? plan.egress.join("、") : "なし";
  const body = (
    <div className="space-y-3">
      <dl className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg bg-gray-50 px-3 py-2">
          <dt className="text-xs text-gray-500">実行場所</dt>
          <dd className="mt-1 text-sm font-medium text-gray-900">{LOCATION_LABELS[plan.execution_location]}</dd>
        </div>
        <div className="rounded-lg bg-gray-50 px-3 py-2">
          <dt className="text-xs text-gray-500">外部への通信</dt>
          <dd className="mt-1 text-sm font-medium text-gray-900">{plan.egress.length ? `${egress} のみ` : "行いません"}</dd>
        </div>
        <div className="rounded-lg bg-gray-50 px-3 py-2">
          <dt className="text-xs text-gray-500">承認</dt>
          <dd className="mt-1 text-sm font-medium text-gray-900">{plan.requires_human ? "AWS管理者の承認が必要" : "不要（自動で用意）"}</dd>
        </div>
      </dl>
      <p className="text-sm leading-6 text-gray-700"><span className="font-medium">理由:</span> {plan.reason}</p>
      <details className="group rounded-lg border border-gray-200">
        <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-xs font-medium text-gray-600">
          詳しい設定を見る
          <ChevronDown className="h-4 w-4 transition group-open:rotate-180" aria-hidden="true" />
        </summary>
        <dl className="grid gap-2 border-t border-gray-100 px-3 py-3 text-xs text-gray-600 sm:grid-cols-2">
          <div><dt className="text-gray-400">実行環境の種類</dt><dd className="font-mono">{plan.kind}</dd></div>
          <div><dt className="text-gray-400">環境キー</dt><dd className="font-mono">{plan.profile_key}</dd></div>
          {plan.template ? <div><dt className="text-gray-400">作業テンプレート</dt><dd>{TEMPLATE_LABELS[plan.template] ?? plan.template}</dd></div> : null}
          {plan.network ? <div><dt className="text-gray-400">コンテナのネットワーク</dt><dd>{plan.network.mode === "disabled" ? "外部接続なし（連携はTool Gateway経由）" : plan.network.mode === "restricted" ? `許可ドメインのみ: ${(plan.network.allowed_domains ?? []).join("、")}` : "制限なし"}</dd></div> : null}
        </dl>
      </details>
    </div>
  );
  if (compact) return body;
  return (
    <Card>
      <CardHeader
        title={<span className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-emerald-600" aria-hidden="true" />Agentが選んだ構成</span>}
        description="実行場所と通信範囲はBuilder Agentが業務内容から決めました。変更が必要な場合は管理者が「設定 > 詳細設定」から行えます。"
        actions={<Badge tone={plan.requires_human ? "warning" : "success"} dot>{plan.requires_human ? "承認待ち" : "自動設定"}</Badge>}
      />
      <CardBody>{body}</CardBody>
    </Card>
  );
}
