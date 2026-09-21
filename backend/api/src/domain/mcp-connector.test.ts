import { describe, expect, it } from "vitest";
import { inspectMcpDiscovery } from "./mcp-connector.js";

const discovered = [
  {
    name: "search-docs",
    description: "Search public documentation",
    input_schema: {
      type: "object" as const,
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    read_only: true,
    destructive: false,
  },
  {
    name: "publish_article",
    description: "Publish an article",
    input_schema: { type: "object" as const, properties: { title: { type: "string" } } },
    read_only: null,
    destructive: false,
  },
  {
    name: "delete_all",
    description: "Delete records",
    input_schema: { type: "object" as const, properties: {} },
    read_only: true,
    destructive: true,
  },
];

describe("MCP Connector Builder", () => {
  it("remote名、入力Schema、注釈から決定的なToolを生成する", () => {
    const proposal = inspectMcpDiscovery({ server_url: "https://mcp.example.com/mcp" }, discovered);
    expect(proposal.connector).toMatchObject({ key: "mcp", adapter: "mcp", auth_type: "none" });
    expect(proposal.operations.map((operation) => [operation.remote_name, operation.risk])).toEqual([
      ["search-docs", "read"],
      ["publish_article", "write"],
      ["delete_all", "destructive"],
    ]);
    expect(proposal.operations[0]).toMatchObject({
      name: "mcp_search_docs",
      provider_operation_name: "search-docs",
      input_schema: { required: ["query"] },
    });
    expect(proposal.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("readOnlyHint未申告"),
      expect.stringContaining("Studio内"),
    ]));
  });

  it("選択対象とBearer認証待ちを固定する", () => {
    const proposal = inspectMcpDiscovery({
      server_url: "https://mcp.example.com/mcp",
      connector_key: "docs-mcp",
      auth_type: "static_bearer",
      selected_tool_names: ["search-docs"],
    }, discovered);
    expect(proposal.authentication).toEqual({ kind: "bearer", requires_human_action: true });
    expect(proposal.operations.filter((operation) => operation.selected).map((operation) => operation.remote_name)).toEqual(["search-docs"]);
    expect(proposal.source.content_hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
