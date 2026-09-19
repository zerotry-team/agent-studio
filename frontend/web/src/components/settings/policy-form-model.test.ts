import { describe, expect, it } from "vitest";
import { describePolicy } from "./policy-describe";
import {
  buildCondition,
  buildPolicyRule,
  initialPolicyFormState,
  newConditionRow,
  parseConditionValue,
  previewPolicyRule,
  validatePolicyForm,
  type PolicyFormState,
} from "./policy-form-model";

function state(overrides: Partial<PolicyFormState>): PolicyFormState {
  return { ...initialPolicyFormState(), name: "テスト", ...overrides };
}

describe("parseConditionValue", () => {
  it("数値・真偽値・文字列に変換する", () => {
    expect(parseConditionValue(">", " 500 ")).toBe(500);
    expect(parseConditionValue(">", "-1.5")).toBe(-1.5);
    expect(parseConditionValue(">", "５００")).toBe(500);
    expect(parseConditionValue("==", "true")).toBe(true);
    expect(parseConditionValue("==", "false")).toBe(false);
    expect(parseConditionValue("==", "gold")).toBe("gold");
    expect(parseConditionValue("==", "0x10")).toBe("0x10");
  });

  it("次のいずれか はカンマ区切りの配列にする", () => {
    expect(parseConditionValue("in", "gold, silver、3，")).toEqual(["gold", "silver", 3]);
    expect(parseConditionValue("not_in", "  ")).toEqual([]);
  });
});

describe("buildCondition", () => {
  it("条件なしなら undefined", () => {
    expect(buildCondition({ mode: "none", rows: [newConditionRow({ field: "a", value: "1" })] })).toBeUndefined();
  });

  it("1つの条件は比較そのもの（abs は数値の比べ方だけ）", () => {
    expect(
      buildCondition({ mode: "single", rows: [newConditionRow({ field: "price_change", op: ">", value: "500", abs: true })] }),
    ).toEqual({ field: "price_change", op: ">", value: 500, abs: true });
    expect(
      buildCondition({ mode: "single", rows: [newConditionRow({ field: "rank", op: "in", value: "a,b", abs: true })] }),
    ).toEqual({ field: "rank", op: "in", value: ["a", "b"] });
  });

  it("すべて / いずれか", () => {
    const rows = [newConditionRow({ field: "a", op: ">=", value: "1" }), newConditionRow({ field: "b.c", op: "==", value: "x" })];
    expect(buildCondition({ mode: "all", rows })).toEqual({
      all: [
        { field: "a", op: ">=", value: 1 },
        { field: "b.c", op: "==", value: "x" },
      ],
    });
    expect(buildCondition({ mode: "any", rows })).toEqual({
      any: [
        { field: "a", op: ">=", value: 1 },
        { field: "b.c", op: "==", value: "x" },
      ],
    });
  });
});

describe("buildPolicyRule / validatePolicyForm", () => {
  it("承認: 条件と期限", () => {
    const s = state({
      tool: "update_price",
      condition: { mode: "single", rows: [newConditionRow({ field: "price_change", op: ">", value: "500", abs: true })] },
      reason: "  大きな値引き  ",
    });
    const result = validatePolicyForm(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input).toEqual({
      name: "テスト",
      enabled: true,
      rule: {
        type: "approval",
        tool: "update_price",
        when: { field: "price_change", op: ">", value: 500, abs: true },
        timeout_minutes: 1440,
        reason: "大きな値引き",
      },
    });
    expect(describePolicy(result.rule)).toBe(
      "update_price: price_change の絶対値が 500 より大きいとき、承認が必要（期限 1440 分）",
    );
  });

  it("期限が空欄なら既定値（1440 分）", () => {
    const result = validatePolicyForm(state({ timeoutMinutes: "" }));
    expect(result.ok && result.rule.type === "approval" ? result.rule.timeout_minutes : null).toBe(1440);
  });

  it("呼び出し回数の上限", () => {
    const rule = buildPolicyRule(state({ type: "rate_limit", tool: "send_email", maxCalls: "3" }));
    expect(rule).toEqual({ type: "rate_limit", tool: "send_email", max_calls_per_session: 3 });
    const result = validatePolicyForm(state({ type: "rate_limit", tool: "send_email", maxCalls: "0" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors["rule.max_calls_per_session"]).toBeTruthy();
  });

  it("使える時間帯", () => {
    const result = validatePolicyForm(state({ type: "time_window", startHour: 9, endHour: 18, weekdaysOnly: true }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(describePolicy(result.rule)).toBe("すべてのツール: 平日の 9時〜18時（Asia/Tokyo）だけ使える");
    const same = validatePolicyForm(state({ type: "time_window", startHour: 9, endHour: 9 }));
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.errors["rule.end_hour"]).toBeTruthy();
  });

  it("エラーは createPolicySchema のパスで返す", () => {
    const result = validatePolicyForm(
      state({
        name: " ",
        type: "deny",
        condition: {
          mode: "all",
          rows: [newConditionRow({ field: "ok_field", op: ">", value: "abc" }), newConditionRow({ field: "1bad", op: "in", value: "" })],
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.name).toBeTruthy();
    expect(result.errors["rule.when.all.0.value"]).toBeTruthy();
    expect(result.errors["rule.when.all.1.field"]).toBeTruthy();
    expect(result.errors["rule.when.all.1.value"]).toBeTruthy();
    expect(result.errors["rule.when.all.0.field"]).toBeUndefined();
  });

  it("1つの条件のエラーは rule.when.* に付く", () => {
    const result = validatePolicyForm(state({ condition: { mode: "single", rows: [newConditionRow({ field: "", value: "1" })] } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors["rule.when.field"]).toBeTruthy();
  });

  it("プレビューは名前が空でも rule を返す", () => {
    expect(previewPolicyRule(state({ name: "" }))).not.toBeNull();
    expect(previewPolicyRule(state({ type: "rate_limit", maxCalls: "" }))).toBeNull();
  });
});
