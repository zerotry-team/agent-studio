import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { BROWSER_TOOLS, callBrowserTool } from "./actions.js";
import type { BrowserSession } from "./session.js";

const MAX_BODY = 1024 * 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.from(raw);
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createBrowserServer(session: BrowserSession, version: string): Server {
  const expectedPath = `/mcp/${session.config.sessionToken}`;
  return createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/health") return json(res, 200, { status: "ok", mode: session.config.mode });
    if (path !== expectedPath) return json(res, 404, { error: "not_found" });
    if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });

    let body: unknown;
    try {
      body = await readBody(req);
    } catch (error) {
      return json(res, error instanceof Error && error.message === "body_too_large" ? 413 : 400, { error: "invalid_request" });
    }

    const mcp = new McpServer({ name: "agent-studio-browser-session-worker", version }, { capabilities: { tools: {} } });
    mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: BROWSER_TOOLS.filter((tool) =>
        (tool.name !== "browser_exec_js" || session.config.codeExecutionEnabled)
        && (tool.name !== "computer_action" || session.config.computerActionsEnabled)),
    }));
    mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const args = request.params.arguments;
      return callBrowserTool(session, request.params.name, args && typeof args === "object" && !Array.isArray(args) ? args : {});
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close().catch(() => undefined);
      void mcp.close().catch(() => undefined);
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) json(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Browser tool failed" } });
    }
  });
}
