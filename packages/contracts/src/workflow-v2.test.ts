import { describe, expect, it } from "vitest";
import { workflowDefinitionSchema } from "./api.js";

const deployment = "00000000-0000-4000-8000-000000000001";

describe("Workflow v2 contract", () => {
  it("Tool、条件分岐、承認、補償を型付きグラフとして受け入れる", () => {
    const parsed = workflowDefinitionSchema.parse({
      version: 2,
      start: "load",
      steps: [
        { type: "tool", key: "load", name: "申込取得", deployment_id: deployment, tool_name: "get_application", arguments_template: '{"invoice_id":"{{input}}"}', next: "under-limit", retries: 2, compensate: "rollback" },
        { type: "condition", key: "under-limit", name: "100万円未満", condition: { source: "step", step_key: "load", path: "requested_amount", operator: "lt", value: 1_000_000 }, if_true: "approve", if_false: "hold" },
        { type: "approval", key: "approve", name: "最終承認", message: "審査結果を確認", next: "write", on_denied: "hold" },
        { type: "tool", key: "write", name: "結果記録", deployment_id: deployment, tool_name: "record_screening", arguments_template: '{"idempotency_key":"workflow:run:write"}' },
        { type: "transform", key: "hold", name: "保留", output_template: '{"decision":"保留"}' },
        { type: "compensate", key: "rollback", name: "補償", deployment_id: deployment, input_template: "{{steps.load.output}}" },
      ],
    });
    expect(parsed.start).toBe("load");
    expect(parsed.steps.map((step) => step.type)).toEqual(["tool", "condition", "approval", "tool", "transform", "compensate"]);
  });

  it("存在しない遷移先を拒否する", () => {
    expect(workflowDefinitionSchema.safeParse({ steps: [{ type: "approval", key: "approve", name: "承認", message: "確認", next: "missing" }] }).success).toBe(false);
  });
});
