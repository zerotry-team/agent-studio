import type { SessionGrant } from "@agent-studio/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CatalogTool, ToolCatalog } from "./catalog.js";
import type { ToolCallService } from "./tool-call.js";

export interface McpServerDeps {
  catalog: Pick<ToolCatalog, "visibleFor">;
  toolCalls: Pick<ToolCallService, "call">;
  version: string;
}

export function toMcpTool(tool: CatalogTool): Tool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as Tool["inputSchema"],
    annotations: {
      readOnlyHint: tool.risk === "read",
      destructiveHint: tool.risk === "destructive",
    },
  };
}

/**
 * 1 リクエスト分の MCP サーバー（stateless）。
 * ツールの JSON Schema をそのまま中継するため、低レベルのハンドラを直接登録する。
 */
export function createSessionMcpServer(grant: SessionGrant, deps: McpServerDeps): McpServer {
  const mcp = new McpServer(
    { name: "agent-studio-tool-gateway", version: deps.version },
    { capabilities: { tools: { listChanged: false } } },
  );
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: deps.catalog.visibleFor(grant).map(toMcpTool),
  }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async (request) =>
    deps.toolCalls.call(grant, request.params.name, request.params.arguments),
  );
  return mcp;
}
