import { describe, expect, it } from "vitest";
import { parseManifest, type AgentManifest, type ToolVersionSpec } from "@agent-studio/contracts";
import { compileAgent, RUNTIME_GATEWAY_SERVER_LABEL, type CompileProfile, type ResolvedTool } from "./manifest-compiler.js";
import { buildSessionCreateParams } from "./session-params.js";

const manifest = (yaml: string): AgentManifest => {
  const r = parseManifest(yaml);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.manifest;
};

const tool = (name: string, spec: ToolVersionSpec): ResolvedTool => ({ tool_id: `t-${name}`, tool_version_id: `v-${name}`, name, version: 1, spec });

const runtimeTool = (name: string, risk: "read" | "financial" | "destructive" | "write" | "external_send", untrusted = false) =>
  tool(name, { execution_location: "runtime_mcp", description: name, risk, input_schema: { type: "object" }, reads_untrusted_content: untrusted });

const selfHosted = (catalog: string[], untrusted: string[] = []): CompileProfile => ({
  id: "p",
  key: "sample-a-production",
  type: "self_hosted",
  template: null,
  network: null,
  runtime: {
    id: "r",
    status: "active",
    gateway_url: "http://gateway.example.internal:8080/mcp",
    tool_catalog: catalog.map((name) => ({
      name,
      description: name,
      input_schema: { type: "object" },
      risk: "read",
      reads_untrusted_content: untrusted.includes(name),
    })),
  },
});

const pricing = manifest(`
agent: { key: pricing-agent, name: 価格変更 }
instructions: 価格を変える
tools: [get_product, update_price]
policies:
  - type: approval
    tool: update_price
    when: { field: price_change, op: ">", value: 500, abs: true }
`);

describe("compileAgent", () => {
  it("Runtime のツールは Tool Gateway 経由になり、ポリシーが引き継がれる", () => {
    const r = compileAgent({
      manifest: pricing,
      tools: [runtimeTool("get_product", "read"), runtimeTool("update_price", "financial")],
      profile: selfHosted(["get_product", "update_price"]),
      orgPolicies: [{ type: "rate_limit", tool: "*", max_calls_per_session: 50 }],
      defaultModel: "m",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.runtime_tools).toEqual(["get_product", "update_price"]);
    expect(r.config.environment).toEqual({ type: "self_hosted", runtime_id: "r", workspace_directory: "/workspace" });
    expect(r.config.policies.map((p) => p.type)).toEqual(["rate_limit", "approval"]);
    expect(r.config.instructions).toContain("承認が必要です");
    expect(r.config.instructions).toContain("価格を変える");
  });

  it("Runtime に報告されていないツールはデプロイできない（DEP-02）", () => {
    const r = compileAgent({
      manifest: pricing,
      tools: [runtimeTool("get_product", "read"), runtimeTool("update_price", "financial")],
      profile: selfHosted(["get_product"]),
      orgPolicies: [],
      defaultModel: "m",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("update_price");
  });

  it("社内システムのツールは OpenAI の環境では使えない", () => {
    const r = compileAgent({
      manifest: pricing,
      tools: [runtimeTool("get_product", "read"), runtimeTool("update_price", "financial")],
      profile: { id: "p", key: "openai", type: "openai_hosted", template: "general-python", network: { mode: "disabled" }, runtime: null },
      orgPolicies: [],
      defaultModel: "m",
    });
    expect(r.ok).toBe(false);
  });

  it("登録前・無効な Runtime にはデプロイできない", () => {
    for (const status of ["provisioning", "pending", "revoked"]) {
      const profile = selfHosted(["get_product", "update_price"]);
      profile.runtime!.status = status;
      const r = compileAgent({ manifest: pricing, tools: [runtimeTool("get_product", "read"), runtimeTool("update_price", "financial")], profile, orgPolicies: [], defaultModel: "m" });
      expect(r.ok).toBe(false);
    }
  });

  it("取り消せない操作には暗黙の承認を付ける", () => {
    const m = manifest("agent: { key: test-agent, name: テスト }\ninstructions: x\ntools: [delete_product]\n");
    const r = compileAgent({ manifest: m, tools: [runtimeTool("delete_product", "destructive")], profile: selfHosted(["delete_product"]), orgPolicies: [], defaultModel: "m" });
    expect(r.ok && r.config.policies).toEqual([expect.objectContaining({ type: "approval", tool: "delete_product" })]);
  });

  it("外部への投稿は入力元に関係なく暗黙の承認を付ける", () => {
    const m = manifest("agent: { key: test-agent, name: テスト }\ninstructions: x\ntools: [publish_x_post]\n");
    const r = compileAgent({ manifest: m, tools: [runtimeTool("publish_x_post", "external_send")], profile: selfHosted(["publish_x_post"]), orgPolicies: [], defaultModel: "m" });
    expect(r.ok && r.config.policies).toEqual([
      expect.objectContaining({ type: "approval", tool: "publish_x_post", reason: expect.stringContaining("外部へ情報を送信・公開") }),
    ]);
  });

  it("外部の内容を読むツールがあれば、更新系の操作をすべて承認制にする（POL-07）", () => {
    const m = manifest("agent: { key: test-agent, name: テスト }\ninstructions: x\ntools: [browser_snapshot, update_price]\n");
    const r = compileAgent({
      manifest: m,
      tools: [runtimeTool("browser_snapshot", "read", true), runtimeTool("update_price", "financial")],
      profile: selfHosted(["browser_snapshot", "update_price"]),
      orgPolicies: [],
      defaultModel: "m",
    });
    expect(r.ok && r.config.policies).toEqual([expect.objectContaining({ type: "approval", tool: "update_price" })]);
  });

  it("モデルが決まらなければエラー", () => {
    const m = manifest("agent: { key: test-agent, name: テスト }\ninstructions: x\n");
    const r = compileAgent({ manifest: m, tools: [], profile: { id: "p", key: "n", type: "none", template: null, network: null, runtime: null }, orgPolicies: [], defaultModel: "" });
    expect(r.ok).toBe(false);
  });
});

describe("buildSessionCreateParams", () => {
  it("OpenAI標準Web SearchをConnectionなしでSessionへ渡す", () => {
    const m = manifest("agent: { key: news-agent, name: 最新ニュース }\ninstructions: 最新情報を調べる\ntools: [web_search]\n");
    const webSearch: ResolvedTool = {
      tool_id: "openai-builtin:web-search",
      tool_version_id: "openai-builtin:web-search:v1",
      name: "web_search",
      version: 1,
      spec: {
        execution_location: "openai_builtin",
        description: "最新情報を検索する",
        input_schema: { type: "object", properties: {} },
        risk: "read",
        reads_untrusted_content: true,
        openai_builtin: { type: "web_search" },
      },
    };
    const compiled = compileAgent({
      manifest: m,
      tools: [webSearch],
      profile: { id: "p", key: "n", type: "none", template: null, network: null, runtime: null },
      orgPolicies: [],
      defaultModel: "m",
    });
    if (!compiled.ok) throw new Error(compiled.errors.join(","));
    expect(compiled.config.openai_builtin_tools).toEqual(["web_search"]);
    const params = buildSessionCreateParams(compiled.config, { vaults: new Map(), metadata: {} });
    expect(params.agent?.tools).toContainEqual({ type: "web_search", mode: "live" });
  });

  it("Tool Gateway の MCP は環境から接続し、セッション用トークンをヘッダで渡す", () => {
    const r = compileAgent({
      manifest: pricing,
      tools: [runtimeTool("get_product", "read"), runtimeTool("update_price", "financial")],
      profile: selfHosted(["get_product", "update_price"]),
      orgPolicies: [],
      defaultModel: "m",
    });
    if (!r.ok) throw new Error();
    const params = buildSessionCreateParams(r.config, {
      gateway: { url: "http://gateway.example.internal:8080/mcp", sessionToken: "tok" },
      vaults: new Map(),
      metadata: { run_id: "x" },
    });
    expect(params.environment).toEqual({ type: "self_hosted", workspace_directory: "/workspace" });
    expect(params.agent?.tools).toEqual([
      {
        type: "mcp",
        server_label: RUNTIME_GATEWAY_SERVER_LABEL,
        connection_origin: "environment",
        transport: { type: "http", server_url: "http://gateway.example.internal:8080/mcp", headers: { Authorization: "Bearer tok" } },
        allowed_tools: ["get_product", "update_price"],
        required: true,
      },
    ]);
    // コンパイル結果（DB に保存される）にはトークンが入らない
    expect(JSON.stringify(r.config)).not.toContain("tok");
  });

  it("OpenAI の環境: ネットワーク方針とテンプレートのパッケージ", () => {
    const m = manifest("agent: { key: test-agent, name: テスト }\ninstructions: x\n");
    const r = compileAgent({
      manifest: m,
      tools: [],
      profile: { id: "p", key: "o", type: "openai_hosted", template: "data-analysis", network: { mode: "restricted", allowed_domains: ["example.com"] }, runtime: null },
      orgPolicies: [],
      defaultModel: "m",
    });
    if (!r.ok) throw new Error();
    const params = buildSessionCreateParams(r.config, { vaults: new Map(), metadata: {} });
    expect(params.environment).toMatchObject({
      type: "openai_hosted",
      network: { access: "restricted", allowed_domains: ["example.com"] },
      packages: { python: expect.arrayContaining(["pandas"]) },
    });
  });
});
