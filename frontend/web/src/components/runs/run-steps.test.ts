import { describe, expect, it } from "vitest";
import type { RunEventDto } from "@agent-studio/contracts";
import { buildRunSteps } from "./run-steps";

const event = (seq: number, type: RunEventDto["type"], data: Record<string, unknown>, summary = ""): RunEventDto => ({
  seq, type, data, summary, created_at: "2026-09-20T13:48:00Z",
});
const requested = (seq: number, id: string) => event(seq, "approval.requested", { approval_id: id, tool: "create_page" });

describe("同じ操作の承認を繰り返す", () => {
  it("1回目の失敗後に2回目の承認を独立した依頼として保持する", () => {
    const steps = buildRunSteps([
      requested(1, "first"),
      event(2, "approval.decided", { approval_id: "first", status: "approved" }),
      event(3, "tool.call", { name: "create_page", error: "HTTP 400" }),
      requested(4, "second"),
    ], { tools: new Map() });
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ approvalId: "first", approval: "approved", state: "failed" });
    expect(steps[1]).toMatchObject({ approvalId: "second", approval: "pending", state: "waiting" });
  });
  it("ツール名のない承認結果を承認IDで対応付ける", () => {
    const steps = buildRunSteps([
      requested(1, "first"), requested(2, "second"),
      event(3, "approval.decided", { approval_id: "first", status: "denied" }),
      event(4, "approval.decided", { approval_id: "second", status: "approved" }),
    ], { tools: new Map() });
    expect(steps[0]).toMatchObject({ approvalId: "first", approval: "denied", state: "failed" });
    expect(steps[1]).toMatchObject({ approvalId: "second", approval: "approved", state: "running" });
  });
});
