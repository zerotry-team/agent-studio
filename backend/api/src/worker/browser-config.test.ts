import { describe, expect, it } from "vitest";
import type { CompiledAgentConfig } from "../domain/manifest-compiler.js";
import { browserConfigForRun } from "./run-driver.js";

const config = (
  runtimeTools: string[],
  browserAccess?: CompiledAgentConfig["browser_access"],
): CompiledAgentConfig => ({
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
  variables: {},
  ...(browserAccess ? { browser_access: browserAccess } : {}),
});

describe("browserConfigForRun", () => {
  it("Browser Toolが無ければTaskを起動しない", () => {
    expect(browserConfigForRun(config(["get_product"]))).toBeUndefined();
  });

  it("指定したドメインだけをRunのallowlistへ固定する", () => {
    expect(
      browserConfigForRun(
        config(["browser_navigate", "browser_exec_js"], { access: "restricted", allowed_domains: ["Example.com", "docs.example.net"] }),
      ),
    ).toMatchObject({
      enabled: true,
      mode: "public_ephemeral",
      allow_public_web: false,
      allowed_domains: ["example.com", "docs.example.net"],
      code_execution_enabled: true,
      viewport: { width: 1440, height: 900 },
    });
  });

  it("公開Web全般を許可する設定では allowlist を使わない", () => {
    expect(browserConfigForRun(config(["browser_navigate"], { access: "public", allowed_domains: [] }))).toMatchObject({
      allow_public_web: true,
      allowed_domains: [],
    });
  });

  it("未設定なら何処にも接続させない", () => {
    expect(browserConfigForRun(config(["browser_navigate"]))).toMatchObject({ allow_public_web: false, allowed_domains: [] });
  });
});
