import { describe, expect, it } from "vitest";
import {
  approvalDecision,
  assertApprovalConfiguration,
  isExternalApproval,
  parseDemoApprovalMode,
} from "./approval-mode";

describe("demo approval mode", () => {
  it("defaults to safe_auto", () => {
    expect(parseDemoApprovalMode(undefined)).toBe("safe_auto");
  });

  it("automatically approves internal recording in safe_auto", () => {
    expect(approvalDecision({ tool: "record_screening", reason: "審査結果を記録" }, "safe_auto", false)).toBe("approve");
  });

  it("automatically denies external publication in safe_auto", () => {
    const approval = { tool: "publish_post", reason: "匿名化済みX投稿の最終承認" };
    expect(isExternalApproval(approval)).toBe(true);
    expect(approvalDecision(approval, "safe_auto", false)).toBe("deny");
  });

  it("allows every approval only when external publication is explicitly enabled", () => {
    expect(() => assertApprovalConfiguration("all", false)).toThrow(/DEMO_ALLOW_EXTERNAL_PUBLISH/);
    expect(approvalDecision({ tool: "publish_post", reason: "外部公開" }, "all", true)).toBe("approve");
  });

  it("leaves every approval pending in manual mode", () => {
    expect(approvalDecision({ tool: "record_screening", reason: "記録" }, "manual", false)).toBe("wait");
  });
});
