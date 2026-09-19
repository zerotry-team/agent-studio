import { describe, expect, it } from "vitest";
import { conditionMatches, evaluatePolicies, policySchema, type Policy } from "./policy.js";

const p = (x: unknown): Policy => policySchema.parse(x);
const now = new Date("2026-09-18T03:00:00Z"); // 金曜 12:00 JST

describe("evaluatePolicies", () => {
  const approvalOver500 = p({
    type: "approval",
    tool: "update_price",
    when: { field: "price_change", op: ">", value: 500, abs: true },
  });

  it("条件に当てはまらなければ許可", () => {
    expect(evaluatePolicies([approvalOver500], { tool: "update_price", args: { price_change: -400 }, now, callsSoFar: 0 })).toEqual({
      action: "allow",
    });
  });

  it("絶対値で比較して承認が必要になる", () => {
    const d = evaluatePolicies([approvalOver500], { tool: "update_price", args: { price_change: -600 }, now, callsSoFar: 0 });
    expect(d.action).toBe("require_approval");
  });

  it("判定できない引数は安全側（承認が必要）に倒す", () => {
    expect(evaluatePolicies([approvalOver500], { tool: "update_price", args: {}, now, callsSoFar: 0 }).action).toBe("require_approval");
    expect(evaluatePolicies([approvalOver500], { tool: "update_price", args: { price_change: "abc" }, now, callsSoFar: 0 }).action).toBe(
      "require_approval",
    );
  });

  it("数値文字列は数値として扱う", () => {
    expect(evaluatePolicies([approvalOver500], { tool: "update_price", args: { price_change: "100" }, now, callsSoFar: 0 }).action).toBe("allow");
  });

  it("拒否は承認より優先される", () => {
    const deny = p({ type: "deny", tool: "*", when: { field: "price_change", op: ">", value: 10000, abs: true } });
    const d = evaluatePolicies([approvalOver500, deny], { tool: "update_price", args: { price_change: 20000 }, now, callsSoFar: 0 });
    expect(d.action).toBe("deny");
  });

  it("別ツールのポリシーは適用しない", () => {
    expect(evaluatePolicies([approvalOver500], { tool: "get_product", args: {}, now, callsSoFar: 0 }).action).toBe("allow");
  });

  it("回数制限", () => {
    const rl = p({ type: "rate_limit", tool: "update_price", max_calls_per_session: 2 });
    expect(evaluatePolicies([rl], { tool: "update_price", args: {}, now, callsSoFar: 1 }).action).toBe("allow");
    expect(evaluatePolicies([rl], { tool: "update_price", args: {}, now, callsSoFar: 2 }).action).toBe("deny");
  });

  it("時間帯（Asia/Tokyo）", () => {
    const tw = p({ type: "time_window", tool: "*", start_hour: 9, end_hour: 18, weekdays_only: true });
    expect(evaluatePolicies([tw], { tool: "x", args: {}, now, callsSoFar: 0 }).action).toBe("allow");
    const night = new Date("2026-09-18T12:00:00Z"); // 21:00 JST
    expect(evaluatePolicies([tw], { tool: "x", args: {}, now: night, callsSoFar: 0 }).action).toBe("deny");
    const saturday = new Date("2026-09-19T03:00:00Z");
    expect(evaluatePolicies([tw], { tool: "x", args: {}, now: saturday, callsSoFar: 0 }).action).toBe("deny");
  });

  it("承認の期限は最も短いものを採用", () => {
    const a = p({ type: "approval", tool: "*", timeout_minutes: 60 });
    const b = p({ type: "approval", tool: "update_price", timeout_minutes: 30 });
    const d = evaluatePolicies([a, b], { tool: "update_price", args: {}, now, callsSoFar: 0 });
    expect(d).toMatchObject({ action: "require_approval", timeout_minutes: 30 });
  });
});

describe("conditionMatches", () => {
  it("in / not_in / all / any", () => {
    expect(conditionMatches({ field: "c", op: "in", value: ["JP", "US"] }, { c: "JP" })).toBe(true);
    expect(conditionMatches({ field: "c", op: "not_in", value: ["JP"] }, { c: "JP" })).toBe(false);
    expect(
      conditionMatches(
        { all: [{ field: "a", op: ">", value: 1 }, { field: "b.c", op: "==", value: "x" }] },
        { a: 2, b: { c: "x" } },
      ),
    ).toBe(true);
    expect(conditionMatches({ any: [{ field: "a", op: ">", value: 5 }, { field: "a", op: "<", value: 0 }] }, { a: 2 })).toBe(false);
  });
});
