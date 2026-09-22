import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { BROWSER_TOOLS, callBrowserTool } from "./actions.js";
import type { BrowserSession } from "./session.js";
import { z } from "zod";

const MAX_BODY = 4 * 1024 * 1024;

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

const humanActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: z.url().max(2000) }).strict(),
  z.object({ type: z.literal("click"), x: z.number().min(0).max(10000), y: z.number().min(0).max(10000) }).strict(),
  z.object({ type: z.literal("type"), value: z.string().max(20_000) }).strict(),
  z.object({ type: z.literal("key"), key: z.string().min(1).max(100) }).strict(),
  z.object({ type: z.literal("scroll"), delta_x: z.number().min(-10000).max(10000), delta_y: z.number().min(-10000).max(10000) }).strict(),
]);

async function screenshot(session: BrowserSession): Promise<{ image: string; url: string; title: string }> {
  const page = session.page();
  const image = await page.screenshot({ type: "jpeg", quality: 75 });
  return { image: image.toString("base64"), url: page.url(), title: await page.title() };
}

async function humanAction(session: BrowserSession, body: unknown): Promise<void> {
  const action = humanActionSchema.parse(body);
  const page = session.page();
  if (action.type === "navigate") await session.navigateForHuman(action.url);
  else if (action.type === "click") await page.mouse.click(action.x, action.y);
  else if (action.type === "type") await page.keyboard.type(action.value);
  else if (action.type === "key") await page.keyboard.press(action.key);
  else await page.mouse.wheel(action.delta_x, action.delta_y);
}

export function createBrowserServer(session: BrowserSession, version: string): Server {
  const expectedPath = `/mcp/${session.config.sessionToken}`;
  const humanPrefix = `/human/${session.config.sessionToken}`;
  const artifactPrefix = `/artifacts/${session.config.sessionToken}/`;
  return createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === "/health") return json(res, 200, { status: "ok", mode: session.config.mode });
    if (path === `${humanPrefix}/screenshot` && req.method === "GET") {
      try {
        return json(res, 200, await screenshot(session));
      } catch {
        return json(res, 500, { error: "screenshot_failed" });
      }
    }
    if (path === `${humanPrefix}/action` && req.method === "POST") {
      try {
        await humanAction(session, await readBody(req));
        return json(res, 200, await screenshot(session));
      } catch (error) {
        const message = error instanceof z.ZodError ? "invalid_action" : error instanceof Error ? error.message : "action_failed";
        return json(res, 400, { error: message });
      }
    }
    if (path === `${humanPrefix}/profile` && req.method === "PUT") {
      try {
        await session.importStorageState((await readBody(req)) as { cookies?: unknown[]; origins?: unknown[] });
        return json(res, 204, null);
      } catch {
        return json(res, 400, { error: "invalid_profile" });
      }
    }
    if (path === `${humanPrefix}/profile` && req.method === "GET") {
      try {
        return json(res, 200, await session.exportStorageState());
      } catch {
        return json(res, 500, { error: "profile_export_failed" });
      }
    }
    // Tool GatewayがDownload本文をRun Artifactとして保存するときだけ使う。モデルへ返すMCPとは別経路
    if (path.startsWith(artifactPrefix) && req.method === "GET") {
      const artifact = session.artifactBody(path.slice(artifactPrefix.length));
      if (!artifact) return json(res, 404, { error: "not_found" });
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(artifact.body.byteLength),
        "cache-control": "no-store",
        "x-artifact-sha256": artifact.sha256,
      });
      res.end(artifact.body);
      return;
    }
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
