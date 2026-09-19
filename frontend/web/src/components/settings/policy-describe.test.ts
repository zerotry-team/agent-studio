import { describe, expect, it } from "vitest";
import { describeCondition, describePolicy } from "./policy-describe";

describe("describePolicy", () => {
  it("承認（条件なし・短い期限）", () => {
    expect(describePolicy({ type: "approval", tool: "delete_order", timeout_minutes: 30 })).toBe(
      "delete_order: 呼び出すたびに承認が必要（期限 30 分）",
    );
  });

  it("禁止（条件あり）", () => {
    expect(
      describePolicy({
        type: "deny",
        tool: "*",
        when: { any: [{ field: "country", op: "not_in", value: ["JP", "US"] }, { field: "amount", op: ">=", value: 1000000 }] },
      }),
    ).toBe("すべてのツール: country が 「JP」、「US」 のいずれでもない、または amount が 1000000 以上とき、使用を禁止");
  });

  it("呼び出し回数の上限", () => {
    expect(describePolicy({ type: "rate_limit", tool: "send_email", max_calls_per_session: 3 })).toBe(
      "send_email: 1回の実行につき 3 回まで",
    );
  });

  it("日をまたぐ時間帯", () => {
    expect(
      describePolicy({ type: "time_window", tool: "batch_job", timezone: "UTC", start_hour: 22, end_hour: 6, weekdays_only: false }),
    ).toBe("batch_job: 22時〜翌6時（UTC）だけ使える");
  });
});

describe("describeCondition", () => {
  it("すべての条件", () => {
    expect(
      describeCondition({
        all: [
          { field: "amount", op: ">", value: 100, abs: true },
          { field: "vip", op: "==", value: true },
        ],
      }),
    ).toBe("amount の絶対値が 100 より大きい、かつ vip が true と等しいとき");
  });
});
