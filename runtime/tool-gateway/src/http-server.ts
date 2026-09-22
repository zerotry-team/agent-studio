import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { SessionGrant } from "@agent-studio/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { GrantResolver } from "./auth.js";
import type { ToolCatalog } from "./catalog.js";
import type { Logger } from "./logger.js";
import { errorMessage } from "./logger.js";

export const MAX_BODY_BYTES = 1024 * 1024;
const REALM = 'Bearer realm="agent-studio-tool-gateway"';

class BodyError extends Error {
  constructor(readonly status: 400 | 413) {
    super(status === 413 ? "body too large" : "invalid json");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);
}

/**
 * 本文を上限まで読む。上限を超えたら 413 にするが、接続は切らずに残りを読み捨てる
 * （切るとクライアントには 413 ではなく EPIPE に見えるため）。
 */
function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new BodyError(413));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.off("data", onData);
        req.off("end", onEnd);
        req.resume();
        reject(new BodyError(413));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new BodyError(400));
      }
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", reject);
  });
}

export interface PublicServerDeps {
  resolver: Pick<GrantResolver, "resolve">;
  createMcpServer: (grant: SessionGrant) => McpServer;
  logger: Logger;
  maxBodyBytes?: number;
  /** Session Worker からの作業領域の成果物（/session-outputs/...） */
  sessionOutputs?: (req: IncomingMessage, res: ServerResponse, path: string) => Promise<void>;
}

/**
 * Session Worker 向けの公開リスナー（VPC 内の 8080）。
 * - /mcp: MCP Streamable HTTP（stateless。リクエストごとにサーバーとトランスポートを作る）
 * - /health
 * CORS は付けない（ブラウザから呼ぶ想定はない）。
 */
export function createPublicHandler(deps: PublicServerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const limit = deps.maxBodyBytes ?? MAX_BODY_BYTES;

  return async (req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";

    if (path === "/health") {
      if (req.method === "GET" || req.method === "HEAD") sendJson(res, 200, { status: "ok" });
      else sendJson(res, 405, { error: "method_not_allowed" }, { allow: "GET" });
      return;
    }
    if (deps.sessionOutputs && path.startsWith("/session-outputs/")) {
      await deps.sessionOutputs(req, res, path);
      return;
    }
    if (path !== "/mcp") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    let auth;
    try {
      auth = await deps.resolver.resolve(req.headers.authorization);
    } catch (err) {
      deps.logger.error({ err: errorMessage(err) }, "セッションを確認できません（Runtime Controller に接続できません）");
      sendJsonRpcError(res, 503, -32603, "セッションを確認できません。しばらくしてから再試行してください");
      return;
    }
    if (!auth.ok) {
      deps.logger.warn({ reason: auth.reason, method: req.method }, "セッション用トークンが無効です");
      sendJsonRpcError(res, 401, -32001, "セッション用トークンが無効です", {
        "www-authenticate": auth.reason === "missing" ? REALM : `${REALM}, error="invalid_token"`,
      });
      return;
    }

    // stateless のため、SSE のストリーム（GET）とセッションの終了（DELETE）は提供しない
    if (req.method !== "POST") {
      sendJsonRpcError(res, 405, -32000, "Method not allowed.", { allow: "POST" });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req, limit);
    } catch (err) {
      if (err instanceof BodyError && err.status === 413) {
        sendJsonRpcError(res, 413, -32600, "リクエストが大きすぎます（上限 1MB）");
      } else {
        sendJsonRpcError(res, 400, -32700, "Parse error");
      }
      return;
    }

    const server = deps.createMcpServer(auth.grant);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      deps.logger.error({ err: errorMessage(err), session_id: auth.grant.session_id }, "MCP のリクエストを処理できませんでした");
      if (!res.headersSent) sendJsonRpcError(res, 500, -32603, "Internal server error");
    }
  };
}

export function createPublicServer(deps: PublicServerDeps): Server {
  const handler = createPublicHandler(deps);
  const server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      deps.logger.error({ err: errorMessage(err) }, "リクエストの処理に失敗しました");
      if (!res.headersSent) sendJsonRpcError(res, 500, -32603, "Internal server error");
      else res.end();
    });
  });
  // 承認待ち（最大 55 秒）と遅いツールを考慮した上限
  server.requestTimeout = 5 * 60_000;
  return server;
}

/** Controller のハートビート用（127.0.0.1:8082） */
export function createInternalServer(catalog: Pick<ToolCatalog, "entries">): Server {
  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (req.method === "GET" && path === "/internal/catalog") return sendJson(res, 200, catalog.entries());
    if (req.method === "GET" && path === "/internal/health") return sendJson(res, 200, { status: "ok" });
    sendJson(res, 404, { error: "not_found" });
  });
}
