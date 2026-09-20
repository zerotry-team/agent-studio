import { describe, expect, it } from "vitest";
import type { CompiledAgentConfig } from "../domain/manifest-compiler.js";
import { browserConfigForRun } from "./run-driver.js";

const config = (runtimeTools: string[], variables: Record<string, string> = {}): CompiledAgentConfig => ({
  version: 1,
  model: "test",
  reasoning_effort: null,
  instructions: "test",
  environment: { type: "self_hosted", runtime_id: "runtime", workspace_directory: "/workspace" },
  function_tools: [],
  service_mcp_tools: [],
  runtime_tools: runtimeTools,
  policies: [],
  warnings: [],
  variables,
});

describe("browserConfigForRun", () => {
  it("Browser Toolが無ければTaskを起動しない", () => {
    expect(browserConfigForRun(config(["get_product"]))).toBeUndefined();
  });

  it("VariableのURLと明示ドメインをRunのallowlistへ固定する", () => {
    expect(
      browserConfigForRun(
        config(["browser_navigate", "browser_exec_js"], {
          BENCHMARK_URL: "https://www.example.com/posts",
          BROWSER_ALLOWED_DOMAINS: "example.com, docs.example.net",
        }),
      ),
    ).toMatchObject({
      enabled: true,
      mode: "public_ephemeral",
      allowed_domains: ["example.com", "docs.example.net", "www.example.com"],
      code_execution_enabled: true,
      viewport: { width: 1440, height: 900 },
    });
  });
});
