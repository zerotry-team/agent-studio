import { describe, expect, it } from "vitest";
import type { CapabilityResolutionDto } from "@agent-studio/contracts";
import type { ResolvedTool } from "../domain/manifest-compiler.js";
import { reconcileVersionResolution } from "./agents.js";

const tool = (name: string, connectorId: string | null = null): ResolvedTool => ({
  tool_id: `${name}-tool`,
  tool_version_id: `${name}-version`,
  name,
  version: 1,
  connector_id: connectorId,
  spec: {
    execution_location: "runtime_mcp",
    description: name,
    input_schema: { type: "object", properties: {} },
    risk: "read",
    reads_untrusted_content: false,
  },
});

describe("reconcileVersionResolution", () => {
  it("Manifestに追加したRuntime ToolをBuild対象へ同期する", () => {
    const current: CapabilityResolutionDto = {
      requirements: [{
        requirement: "申込を取得する",
        state: "resolved",
        connector_id: null,
        connector_name: null,
        tool_names: ["get_application"],
        confidence: 1,
        reason: "既存Tool",
        variables: [],
      }],
      selected_tools: ["get_application"],
      missing_variables: [],
      ready: true,
    };
    const result = reconcileVersionResolution(current, [tool("get_application"), tool("lookup_internal_history")]);
    expect(result.selected_tools).toEqual(["get_application", "lookup_internal_history"]);
    expect(result.requirements).toContainEqual(expect.objectContaining({
      requirement: "lookup_internal_history",
      state: "resolved",
      tool_names: ["lookup_internal_history"],
    }));
    expect(result.ready).toBe(true);
  });

  it("追加したConnector Toolは接続確認が済むまでreadyにしない", () => {
    const current: CapabilityResolutionDto = { requirements: [], selected_tools: [], missing_variables: [], ready: true };
    const result = reconcileVersionResolution(current, [tool("publish_post", "connector-1")]);
    expect(result.requirements[0]).toMatchObject({ state: "needs_connection", connector_id: "connector-1" });
    expect(result.ready).toBe(false);
  });
});
