import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { runtimeToolConfigSchema, sha256Hex, type SessionGrant, type ToolAuditEvent } from "@agent-studio/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GrantResolver } from "./auth.js";
import { buildUpstreamTools, ToolCatalog } from "./catalog.js";
import { createInternalServer, createPublicServer } from "./http-server.js";
import { textResult } from "./http-tool.js";
import { createLogger } from "./logger.js";
import { createSessionMcpServer } from "./mcp-server.js";
import { ToolCallService } from "./tool-call.js";
import { createUpstreamConnector, listUpstreamTools, UpstreamSessionPool } from "./upstream.js";

const logger = createLogger("silent");
const VALID_TOKEN = "session-token-valid-0123456789abcdef";
const OTHER_TOKEN = "session-token-other-0123456789abcdef";

const listen = async (server: Server) => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const close = (server: Server) => new Promise<void>((r) => server.close(() => r()));

// ---------------------------------------------------------------------------
// 配下の MCP サーバー（Playwright MCP の代わり。stateful で、セッションごとに状態を持つ）
// ---------------------------------------------------------------------------
async function startUpstream() {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  let opened = 0;
  let closed = 0;
  const server = createServer(async (req, res) => {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    let transport = sid ? sessions.get(sid) : undefined;
    if (!transport) {
      if (sid) {
        res.writeHead(404).end();
        return;
      }
      let visited: string | undefined; // セッションごとの「ブラウザの状態」
      const mcp = new McpServer({ name: "fake-browser", version: "1.0.0" });
      mcp.registerTool(
        "browser_navigate",
        { description: "ページを開く", inputSchema: { url: z.string() } },
        async ({ url }) => {
          visited = url;
          return { content: [{ type: "text", text: `opened ${url}` }] };
        },
      );
      mcp.registerTool("browser_snapshot", { description: "今のページ" }, async () => ({
        content: [{ type: "text", text: `current ${visited ?? "(none)"}` }],
      }));
      mcp.registerTool("browser_evaluate", { description: "任意の JS（許可リストに入れない）" }, async () => ({
        content: [{ type: "text", text: "danger" }],
      }));
      const created = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, created);
          opened++;
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
          closed++;
        },
      });
      await mcp.connect(created);
      transport = created;
    }
    await transport.handleRequest(req, res);
  });
  const url = await listen(server);
  return { server, url: `${url}/mcp`, stats: () => ({ opened, closed, active: sessions.size }) };
}

describe("Tool Gateway（MCP over HTTP）", () => {
  let upstream: Awaited<ReturnType<typeof startUpstream>>;
  let gateway: Server;
  let internal: Server;
  let gatewayUrl = "";
  let internalUrl = "";
  let pool: UpstreamSessionPool;
  const audits: ToolAuditEvent[] = [];
  const executeHttp = vi.fn(async () => ({ result: textResult('{"product_id":"P-001","price":1480}', false) }));

  const grant = (sessionNo: number, tokenHash: string): SessionGrant => ({
    session_id: `00000000-0000-4000-8000-00000000000${sessionNo}`,
    run_id: "10000000-0000-4000-8000-000000000001",
    token_hash: tokenHash,
    allowed_tools: ["get_product", "browser_open", "browser_snapshot", "not_in_catalog"],
    policies: [],
    expires_at: "2099-01-01T00:00:00.000Z",
  });

  beforeAll(async () => {
    upstream = await startUpstream();
    const config = runtimeToolConfigSchema.parse({
      tools: [
        {
          name: "get_product",
          description: "商品を取得します",
          risk: "read",
          input_schema: { type: "object", properties: { product_id: { type: "string" } }, required: ["product_id"] },
          http: { method: "GET", url: "http://demo.internal/products/{product_id}" },
        },
        {
          name: "update_price",
          description: "このセッションでは許可されていない",
          risk: "financial",
          input_schema: { type: "object" },
          http: { method: "POST", url: "http://demo.internal/products/{product_id}/price" },
        },
      ],
      upstream_mcp: [
        {
          name: "browser",
          url: upstream.url,
          tools: [
            { name: "browser_navigate", expose_as: "browser_open", risk: "read", reads_untrusted_content: true },
            { name: "browser_snapshot", risk: "read", reads_untrusted_content: true },
            { name: "browser_missing", risk: "read" },
          ],
        },
      ],
    });

    const hashes = { valid: await sha256Hex(VALID_TOKEN), other: await sha256Hex(OTHER_TOKEN) };
    const controller = {
      getGrantByTokenHash: vi.fn(async (hash: string) =>
        hash === hashes.valid ? grant(1, hash) : hash === hashes.other ? grant(2, hash) : null,
      ),
      createApproval: vi.fn(),
      getApproval: vi.fn(),
      consumeApproval: vi.fn(),
    };
    const connector = createUpstreamConnector({ name: "test-gateway", version: "0.0.0" });
    const catalog = new ToolCatalog(config, (u) => listUpstreamTools(connector, u), logger);
    await catalog.refreshUpstreams();
    pool = new UpstreamSessionPool(connector, logger, { idleMs: 60_000 });
    const toolCalls = new ToolCallService({
      catalog,
      controller,
      audit: { record: (e) => audits.push({ ...e, at: new Date().toISOString() }) },
      executeHttp,
      upstream: pool,
      approvalWaitMs: 0,
      approvalPollIntervalMs: 100,
      logger,
    });
    gateway = createPublicServer({
      resolver: new GrantResolver(controller),
      createMcpServer: (g) => createSessionMcpServer(g, { catalog, toolCalls, version: "0.0.0" }),
      logger,
    });
    gatewayUrl = `${await listen(gateway)}/mcp`;
    internal = createInternalServer(catalog);
    internalUrl = await listen(internal);
  });

  afterAll(async () => {
    await pool.closeAll();
    await close(gateway);
    await close(internal);
    await close(upstream.server);
  });

  const connect = async (token?: string) => {
    const client = new Client({ name: "session-worker", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(gatewayUrl), {
      requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
    });
    await client.connect(transport);
    return client;
  };

  it("有効なトークンなら、許可されたツール ∩ カタログだけが見える", async () => {
    const client = await connect(VALID_TOKEN);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["get_product", "browser_open", "browser_snapshot"]);
    const open = tools.find((t) => t.name === "browser_open")!;
    expect(open.description).toBe("ページを開く");
    expect(open.inputSchema.properties).toHaveProperty("url");
    expect(tools.find((t) => t.name === "get_product")!.annotations?.readOnlyHint).toBe(true);
    await client.close();
  });

  it("トークンが無い・無効なら 401", async () => {
    await expect(connect()).rejects.toThrow();
    await expect(connect("wrong-token")).rejects.toThrow();
    const res = await fetch(gatewayUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer wrong" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32001 } });
  });

  it("GET / DELETE は 405（stateless）、1MB を超える本文は 413", async () => {
    const auth = { authorization: `Bearer ${VALID_TOKEN}` };
    expect((await fetch(gatewayUrl, { method: "GET", headers: { ...auth, accept: "text/event-stream" } })).status).toBe(405);
    expect((await fetch(gatewayUrl, { method: "DELETE", headers: auth })).status).toBe(405);
    const big = await fetch(gatewayUrl, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(1024 * 1024) } }),
    });
    expect(big.status).toBe(413);
    expect((await fetch(gatewayUrl.replace("/mcp", "/health"))).status).toBe(200);
  });

  it("HTTP ツールを tools/call で実行できる", async () => {
    const client = await connect(VALID_TOKEN);
    const result = await client.callTool({ name: "get_product", arguments: { product_id: "P-001" } });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: '{"product_id":"P-001","price":1480}' }]);
    expect(executeHttp).toHaveBeenCalledTimes(1);
    expect(audits.at(-1)).toMatchObject({ tool: "get_product", decision: "executed" });
    const denied = await client.callTool({ name: "update_price", arguments: { product_id: "P-001", price_change: 1 } });
    expect(denied.isError).toBe(true);
    await client.close();
  });

  it("配下の MCP のツールは、Agent のセッションごとに別の接続（別のブラウザ状態）で実行する", async () => {
    const a = await connect(VALID_TOKEN);
    const b = await connect(OTHER_TOKEN);
    await a.callTool({ name: "browser_open", arguments: { url: "https://example.com/a" } });
    const snapA = await a.callTool({ name: "browser_snapshot", arguments: {} });
    const snapB = await b.callTool({ name: "browser_snapshot", arguments: {} });
    expect(snapA.content).toEqual([{ type: "text", text: "current https://example.com/a" }]);
    expect(snapB.content).toEqual([{ type: "text", text: "current (none)" }]);
    expect(pool.size).toBe(2);
    await a.close();
    await b.close();

    // 許可リストに無いツールは呼べない
    const c = await connect(VALID_TOKEN);
    const r = await c.callTool({ name: "browser_evaluate", arguments: {} });
    expect(r.isError).toBe(true);
    await c.close();

    await pool.closeAll();
    const stats = upstream.stats();
    expect(stats.active).toBe(0);
  });

  it("内部のカタログ（Controller のハートビート用）", async () => {
    const res = await fetch(`${internalUrl}/internal/catalog`);
    const entries = (await res.json()) as Array<{ name: string; risk: string; reads_untrusted_content: boolean }>;
    expect(entries.map((e) => e.name)).toEqual(["get_product", "update_price", "browser_open", "browser_snapshot"]);
    expect(entries.find((e) => e.name === "browser_open")).toMatchObject({ risk: "read", reads_untrusted_content: true });
  });
});

describe("buildUpstreamTools", () => {
  it("許可リストで絞り、名前を付け替え、無いものを報告する", () => {
    const upstream = {
      name: "browser",
      url: "http://browser.internal:8931/mcp",
      tools: [
        { name: "browser_navigate", expose_as: "open_page", risk: "read" as const, reads_untrusted_content: true },
        { name: "browser_close", risk: "write" as const, reads_untrusted_content: false },
      ],
      policies: [],
    };
    const { tools, missing } = buildUpstreamTools(upstream, [
      { name: "browser_navigate", description: "Navigate", inputSchema: { type: "object", properties: { url: { type: "string" } } } },
      { name: "browser_run_code", description: "危険", inputSchema: { type: "object" } },
    ]);
    expect(tools.map((t) => t.name)).toEqual(["open_page"]);
    expect(tools[0]).toMatchObject({ risk: "read", readsUntrustedContent: true, target: { kind: "upstream", toolName: "browser_navigate" } });
    expect(missing).toEqual(["browser_close"]);
  });
});

describe("GrantResolver", () => {
  it("トークンのハッシュで問い合わせ、30 秒キャッシュする（見つからないときは 5 秒）", async () => {
    let now = 0;
    const hash = await sha256Hex(VALID_TOKEN);
    const g: SessionGrant = {
      session_id: "00000000-0000-4000-8000-000000000001",
      run_id: "10000000-0000-4000-8000-000000000001",
      token_hash: hash,
      allowed_tools: [],
      policies: [],
      expires_at: "2099-01-01T00:00:00.000Z",
    };
    const controller = { getGrantByTokenHash: vi.fn(async (h: string) => (h === hash ? g : null)) };
    const resolver = new GrantResolver(controller, { now: () => now });

    expect(await resolver.resolve(`Bearer ${VALID_TOKEN}`)).toMatchObject({ ok: true, tokenHash: hash });
    expect(controller.getGrantByTokenHash).toHaveBeenCalledWith(hash);
    now = 29_000;
    await resolver.resolve(`Bearer ${VALID_TOKEN}`);
    expect(controller.getGrantByTokenHash).toHaveBeenCalledTimes(1);
    now = 31_000;
    await resolver.resolve(`Bearer ${VALID_TOKEN}`);
    expect(controller.getGrantByTokenHash).toHaveBeenCalledTimes(2);

    expect(await resolver.resolve("Bearer nope")).toEqual({ ok: false, reason: "invalid" });
    now = 34_000;
    await resolver.resolve("Bearer nope");
    expect(controller.getGrantByTokenHash).toHaveBeenCalledTimes(3);
    now = 37_000;
    await resolver.resolve("Bearer nope");
    expect(controller.getGrantByTokenHash).toHaveBeenCalledTimes(4);

    expect(await resolver.resolve(undefined)).toEqual({ ok: false, reason: "missing" });
    expect(await resolver.resolve("Basic abc")).toEqual({ ok: false, reason: "invalid" });
  });

  it("期限切れの許可情報は無効", async () => {
    const hash = await sha256Hex(VALID_TOKEN);
    const controller = {
      getGrantByTokenHash: vi.fn(async () => ({
        session_id: "00000000-0000-4000-8000-000000000001",
        run_id: "10000000-0000-4000-8000-000000000001",
        token_hash: hash,
        allowed_tools: [],
        policies: [],
        expires_at: "2020-01-01T00:00:00.000Z",
      })),
    };
    expect(await new GrantResolver(controller).resolve(`Bearer ${VALID_TOKEN}`)).toEqual({ ok: false, reason: "invalid" });
  });
});
