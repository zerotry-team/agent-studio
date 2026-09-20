import { describe, expect, it } from "vitest";
import { resolveCapabilities, type ResolverTool } from "./capability-resolver.js";

const productTool: ResolverTool = {
  name: "get_product",
  display_name: "商品情報の取得",
  description: "商品IDから商品情報を取得する",
  execution_location: "runtime_mcp",
  risk: "read",
  input_fields: ["product_id"],
  connector_id: "connector-products",
  connector_name: "Sample A社 商品API",
  connector_auth_type: "runtime_secret",
};

describe("Capability Resolver", () => {
  it("請求書Agentに無関係なget_productを追加しない", () => {
    const result = resolveCapabilities(
      {
        key: "invoice-agent",
        name: "請求書Agent",
        description: "請求書をPDFにする",
        instructions: "請求書を作成する",
        requirements: [{ description: "請求書PDFを生成", candidate_tools: [], confidence: 1, reason: "該当能力なし" }],
      },
      [productTool],
      new Set(),
    );
    expect(result.selected_tools).toEqual([]);
    expect(result.requirements[0]?.state).toBe("missing");
  });

  it("低信頼候補を自動選択しない", () => {
    const result = resolveCapabilities(
      {
        key: "agent",
        name: "Agent",
        description: "曖昧",
        instructions: "確認する",
        requirements: [{ description: "商品らしき情報", candidate_tools: ["get_product"], confidence: 0.5, reason: "曖昧" }],
      },
      [productTool],
      new Set(["connector-products"]),
    );
    expect(result.selected_tools).toEqual([]);
    expect(result.requirements[0]?.state).toBe("ambiguous");
  });

  it("比較や文章作成などモデル自身の能力はConnectionなしで解決する", () => {
    const result = resolveCapabilities(
      {
        key: "writer",
        name: "Writer",
        description: "投稿案を作る",
        instructions: "分析結果から文章を作る",
        requirements: [{ description: "独自の投稿案を作成", kind: "model", candidate_tools: [], confidence: 0.98, reason: "モデル自身で実行できる" }],
      },
      [productTool],
      new Set(),
    );
    expect(result.selected_tools).toEqual([]);
    expect(result.requirements[0]?.state).toBe("resolved");
    expect(result.ready).toBe(true);
  });

  it("認証が必要なConnectorはConnection設定待ちにする", () => {
    const result = resolveCapabilities(
      {
        key: "product-agent",
        name: "商品Agent",
        description: "商品を取得",
        instructions: "商品を取得する",
        requirements: [{ description: "商品取得", candidate_tools: ["get_product"], confidence: 0.95, reason: "一致" }],
      },
      [productTool],
      new Set(),
    );
    expect(result.selected_tools).toEqual(["get_product"]);
    expect(result.requirements[0]?.state).toBe("needs_connection");
    expect(result.ready).toBe(false);
  });

  it("Browser要件は内部Actionを個別選択させずConnectorの安全なAction群へ展開する", () => {
    const browser = (name: string, risk: ResolverTool["risk"]): ResolverTool => ({
      name,
      display_name: name,
      description: name,
      execution_location: "runtime_mcp",
      risk,
      input_fields: [],
      connector_id: "connector-browser",
      connector_name: "ブラウザ操作",
      connector_auth_type: "none",
    });
    const tools = [browser("browser_navigate", "read"), browser("browser_snapshot", "read"), browser("browser_click", "write"), productTool];
    const result = resolveCapabilities(
      {
        key: "browser-agent",
        name: "Browser Agent",
        description: "公開ページを調査",
        instructions: "調査する",
        requirements: [{ description: "ブラウザで調査", candidate_tools: ["browser_navigate"], confidence: 0.95, reason: "一致" }],
      },
      tools,
      new Set(),
    );
    expect(result.selected_tools).toEqual(["browser_navigate", "browser_snapshot", "browser_click"]);
    expect(result.requirements[0]?.connector_name).toBe("ブラウザ操作");
  });
});
