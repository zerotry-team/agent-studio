import type { AgentManifest, Comparison, Condition, Policy, ReasoningEffort } from "@agent-studio/contracts";
import { Badge } from "@/components/ui/badge";
import { DescriptionList } from "@/components/ui/description-list";
import { CONDITION_OP_LABELS, POLICY_TYPE_LABELS } from "@/lib/utils/labels";

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: "考えない",
  minimal: "最小限",
  low: "少なめ",
  medium: "ふつう",
  high: "多め",
  xhigh: "とても多め",
  max: "最大",
};

function formatValue(value: Comparison["value"]): string {
  if (Array.isArray(value)) return value.map(String).join("、");
  return String(value);
}

/** 比較 1 件を文にする（例: price_change（絶対値）が 500 より大きい） */
export function describeComparison(c: Comparison): string {
  const field = `${c.field}${c.abs ? "（絶対値）" : ""}`;
  const value = formatValue(c.value);
  const op = CONDITION_OP_LABELS[c.op] ?? c.op;
  switch (c.op) {
    case ">":
    case "<":
    case ">=":
    case "<=":
      return `${field} が ${value} ${op}`;
    case "==":
    case "!=":
      return `${field} が ${value} と${op}`;
    case "in":
      return `${field} が「${value}」のいずれか`;
    case "not_in":
      return `${field} が「${value}」のいずれでもない`;
  }
}

/** 「〜のとき」の形にする（例: price_change が 500 以上のとき） */
export function describeCondition(cond: Condition): string {
  if ("all" in cond) return `次のすべてに当てはまるとき（${cond.all.map(describeComparison).join("／")}）`;
  if ("any" in cond) return `次のいずれかに当てはまるとき（${cond.any.map(describeComparison).join("／")}）`;
  const noun = cond.op === ">=" || cond.op === "<=" || cond.op === "in";
  return `${describeComparison(cond)}${noun ? "のとき" : "とき"}`;
}

/** ポリシー 1 件の要約（例: price_change（絶対値）が 500 より大きいときは承認が必要） */
export function describePolicy(policy: Policy): string {
  switch (policy.type) {
    case "approval":
      return policy.when ? `${describeCondition(policy.when)}は承認が必要` : "呼び出すたびに承認が必要";
    case "deny":
      return policy.when ? `${describeCondition(policy.when)}は使用を禁止` : "使用を禁止";
    case "rate_limit":
      return `1回の実行につき ${policy.max_calls_per_session} 回まで`;
    case "time_window":
      return `${policy.weekdays_only ? "平日の" : "毎日"}${policy.start_hour}時〜${policy.end_hour}時（${policy.timezone}）だけ使える`;
  }
}

export function policyToolLabel(tool: string): string {
  return tool === "*" ? "すべてのツール" : tool;
}

export function ToolChips({ tools, empty = "ツールは使いません" }: { tools: readonly string[]; empty?: string }) {
  if (tools.length === 0) return <span className="text-gray-500">{empty}</span>;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="使うツール">
      {tools.map((t) => (
        <li key={t} className="rounded-md border border-gray-200 bg-gray-50 px-2 py-0.5 font-mono text-xs text-gray-800">
          {t}
        </li>
      ))}
    </ul>
  );
}

export function PolicyList({ policies }: { policies: readonly Policy[] }) {
  if (policies.length === 0) return <p className="text-sm text-gray-500">ルールはありません。ツールは制限なく呼び出されます。</p>;
  return (
    <ul className="space-y-2">
      {policies.map((p, i) => (
        <li key={i} className="rounded-lg border border-gray-200 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-semibold text-gray-900">{policyToolLabel(p.tool)}</span>
            <Badge tone={p.type === "approval" ? "warning" : p.type === "deny" ? "danger" : "neutral"}>{POLICY_TYPE_LABELS[p.type]}</Badge>
          </div>
          <p className="mt-1 text-sm leading-relaxed text-gray-700">{describePolicy(p)}</p>
          {"reason" in p && p.reason ? <p className="mt-0.5 text-xs text-gray-500">理由: {p.reason}</p> : null}
        </li>
      ))}
    </ul>
  );
}

/** Manifest の要点（モデル・ツール・ルール・実行環境） */
export function ManifestSummary({ manifest }: { manifest: AgentManifest }) {
  const model = manifest.model ?? {};
  return (
    <div className="space-y-6">
      <DescriptionList
        items={[
          {
            label: "モデル",
            value: model.name ? <span className="font-mono text-[13px]">{model.name}</span> : <span className="text-gray-500">既定のモデル</span>,
          },
          {
            label: "考える量",
            value: model.reasoning_effort ? REASONING_EFFORT_LABELS[model.reasoning_effort] : <span className="text-gray-500">既定</span>,
          },
          {
            label: "既定の実行環境",
            value: manifest.environment?.profile ? (
              <span className="font-mono text-[13px]">{manifest.environment.profile}</span>
            ) : (
              <span className="text-gray-500">指定なし（デプロイするときに選びます）</span>
            ),
          },
          { label: "使うツール", value: <ToolChips tools={manifest.tools ?? []} />, wide: true },
        ]}
      />
      <div>
        <h3 className="text-xs font-medium text-gray-500">
          ルール <span className="font-normal">（{manifest.policies?.length ?? 0} 件）</span>
        </h3>
        <div className="mt-2">
          <PolicyList policies={manifest.policies ?? []} />
        </div>
      </div>
      <div>
        <h3 className="text-xs font-medium text-gray-500">指示</h3>
        <p className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-gray-50 px-3 py-2.5 text-sm leading-relaxed text-gray-800">
          {manifest.instructions}
        </p>
      </div>
    </div>
  );
}
