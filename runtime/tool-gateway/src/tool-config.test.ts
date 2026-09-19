import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseToolConfig, ToolConfigError } from "./tool-config.js";

const httpTool = (url: string, name = "get_product") => ({
  name,
  description: "商品を取得します",
  risk: "read",
  input_schema: { type: "object" },
  http: { method: "GET", url },
});

describe("parseToolConfig", () => {
  it("examples/tool-config.local.yaml を読める", () => {
    const text = readFileSync(new URL("../examples/tool-config.local.yaml", import.meta.url), "utf8");
    const config = parseToolConfig(text, "example");
    expect(config.tools.map((t) => t.name)).toEqual(["list_products", "get_product", "update_price"]);
    expect(config.tools[1]!.http.auth).toEqual({ type: "bearer", secret: "demo-internal-api" });
    expect(config.tools[2]!.policies).toHaveLength(1);
  });

  it("JSON（SSM パラメータの形）も読める", () => {
    const config = parseToolConfig(JSON.stringify({ tools: [httpTool("https://api.internal/products/{product_id}")] }), "ssm");
    expect(config.tools[0]!.http.timeout_ms).toBe(15000);
    expect(config.upstream_mcp).toEqual([]);
  });

  it("接続先のホストに {引数} を使う設定は拒否する", () => {
    expect(() => parseToolConfig(JSON.stringify({ tools: [httpTool("https://{host}/products")] }), "t")).toThrow(ToolConfigError);
    expect(() => parseToolConfig(JSON.stringify({ tools: [httpTool("https://api.internal:{port}/x")] }), "t")).toThrow(/ホスト/);
  });

  it("http / https 以外の URL は拒否する", () => {
    expect(() => parseToolConfig(JSON.stringify({ tools: [httpTool("file:///etc/passwd")] }), "t")).toThrow(/http か https/);
  });

  it("ツール名の重複を拒否する", () => {
    const text = JSON.stringify({
      tools: [httpTool("https://a.internal/x")],
      upstream_mcp: [{ name: "browser", url: "http://browser.internal:8931/mcp", tools: [{ name: "x", expose_as: "get_product", risk: "read" }] }],
    });
    expect(() => parseToolConfig(text, "t")).toThrow(/重複/);
  });

  it("規則に合わない MCP のツール名は expose_as が必要", () => {
    const text = JSON.stringify({
      upstream_mcp: [{ name: "browser", url: "http://browser.internal:8931/mcp", tools: [{ name: "Browser-Navigate", risk: "read" }] }],
    });
    expect(() => parseToolConfig(text, "t")).toThrow(/expose_as/);
  });

  it("スキーマに合わない設定は項目名つきで拒否する", () => {
    expect(() => parseToolConfig("tools:\n  - name: BAD\n", "t")).toThrow(/tools\.0/);
    expect(() => parseToolConfig("tools: [\n", "t")).toThrow(ToolConfigError);
  });
});
