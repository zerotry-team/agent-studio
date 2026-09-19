import type { Comparison, Condition, Policy } from "@agent-studio/contracts";

/**
 * ポリシーのルールを、利用者が読める日本語の 1 文にする（純粋関数）。
 * 例:
 * - 「update_price: price_change の絶対値が 500 より大きいとき、承認が必要（期限 1440 分）」
 * - 「send_email: 1回の実行につき 3 回まで」
 * - 「すべてのツール: 平日の 9時〜18時（Asia/Tokyo）だけ使える」
 */

/** 対象のツール名（"*" は「すべてのツール」） */
export function describePolicyTool(tool: string): string {
  return tool === "*" ? "すべてのツール" : tool;
}

function formatScalar(value: string | number | boolean): string {
  if (typeof value === "string") return `「${value}」`;
  return String(value);
}

function formatValue(value: Comparison["value"]): string {
  if (Array.isArray(value)) return value.map((v) => formatScalar(v)).join("、");
  return formatScalar(value);
}

const LIST_OPS: ReadonlySet<Comparison["op"]> = new Set(["in", "not_in"]);

/** 比較 1 つ（例: 「price_change の絶対値が 500 より大きい」） */
export function describeComparison(c: Comparison): string {
  const subject = c.abs && !LIST_OPS.has(c.op) ? `${c.field} の絶対値が` : `${c.field} が`;
  const v = formatValue(c.value);
  switch (c.op) {
    case ">":
      return `${subject} ${v} より大きい`;
    case ">=":
      return `${subject} ${v} 以上`;
    case "<":
      return `${subject} ${v} より小さい`;
    case "<=":
      return `${subject} ${v} 以下`;
    case "==":
      return `${subject} ${v} と等しい`;
    case "!=":
      return `${subject} ${v} と等しくない`;
    case "in":
      return `${subject} ${v} のいずれか`;
    case "not_in":
      return `${subject} ${v} のいずれでもない`;
  }
}

/** 条件（例: 「amount が 10000 以上、かつ currency が 「USD」 と等しいとき」） */
export function describeCondition(cond: Condition): string {
  if ("all" in cond) return `${cond.all.map(describeComparison).join("、かつ ")}とき`;
  if ("any" in cond) return `${cond.any.map(describeComparison).join("、または ")}とき`;
  return `${describeComparison(cond)}とき`;
}

/** 承認の期限（例: 「期限 1440 分」） */
export function describeTimeout(minutes: number): string {
  return `期限 ${minutes} 分`;
}

/** 時間帯（例: 「平日の 9時〜18時（Asia/Tokyo）」。日をまたぐ場合は「22時〜翌6時」） */
export function describeTimeWindow(rule: Extract<Policy, { type: "time_window" }>): string {
  const end = rule.start_hour > rule.end_hour ? `翌${rule.end_hour}時` : `${rule.end_hour}時`;
  return `${rule.weekdays_only ? "平日の " : ""}${rule.start_hour}時〜${end}（${rule.timezone}）`;
}

/** 対象のツールを含まない、ルールの内容だけの説明（例: 「1回の実行につき 3 回まで」） */
export function describePolicyRule(rule: Policy): string {
  switch (rule.type) {
    case "approval":
      return rule.when
        ? `${describeCondition(rule.when)}、承認が必要（${describeTimeout(rule.timeout_minutes)}）`
        : `呼び出すたびに承認が必要（${describeTimeout(rule.timeout_minutes)}）`;
    case "deny":
      return rule.when ? `${describeCondition(rule.when)}、使用を禁止` : "使用を禁止";
    case "rate_limit":
      return `1回の実行につき ${rule.max_calls_per_session} 回まで`;
    case "time_window":
      return `${describeTimeWindow(rule)}だけ使える`;
  }
}

/** 対象のツールを含めた説明（例: 「send_email: 1回の実行につき 3 回まで」） */
export function describePolicy(rule: Policy): string {
  return `${describePolicyTool(rule.tool)}: ${describePolicyRule(rule)}`;
}
