import { describe, expect, it } from "vitest";
import { formatMonthLabel, isValidMonth, shiftMonth, tokenShare } from "./month";

describe("month", () => {
  it("年をまたいで月をずらす", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2025-12", 1)).toBe("2026-01");
    expect(shiftMonth("2026-09", 0)).toBe("2026-09");
    expect(shiftMonth("bad", 1)).toBe("bad");
  });

  it("形式の確認と表示", () => {
    expect(isValidMonth("2026-09")).toBe(true);
    expect(isValidMonth("2026-13")).toBe(false);
    expect(isValidMonth("2026-9")).toBe(false);
    expect(formatMonthLabel("2026-09")).toBe("2026年9月");
  });

  it("割合", () => {
    expect(tokenShare(25, 100)).toBe(25);
    expect(tokenShare(10, 0)).toBe(0);
  });
});
