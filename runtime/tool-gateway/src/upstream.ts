import type { RuntimeUpstreamMcp, SessionGrant } from "@agent-studio/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "./logger.js";
import { errorMessage } from "./logger.js";

export interface UpstreamConnection {
  client: Pick<Client, "listTools" | "callTool">;
  close(): Promise<void>;
}

export type UpstreamConnector = (upstream: RuntimeUpstreamMcp) => Promise<UpstreamConnection>;

export interface UpstreamToolInfo {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/** VPC 内の MCP サーバー（Streamable HTTP）につなぐ */
export function createUpstreamConnector(clientInfo: { name: string; version: string }, connectTimeoutMs = 15_000): UpstreamConnector {
  return async (upstream) => {
    const transport = new StreamableHTTPClientTransport(new URL(upstream.url));
    const client = new Client(clientInfo, { capabilities: {} });
    await client.connect(transport, { timeout: connectTimeoutMs });
    return {
      client,
      close: async () => {
        // セッションを明示的に終わらせる（Playwright MCP はここでブラウザのコンテキストを閉じる）
        await transport.terminateSession().catch(() => undefined);
        await client.close().catch(() => undefined);
      },
    };
  };
}

/** 配下の MCP サーバーのツール一覧を取る（カタログ用。使い終わったら切断する） */
export async function listUpstreamTools(connect: UpstreamConnector, upstream: RuntimeUpstreamMcp): Promise<UpstreamToolInfo[]> {
  const conn = await connect(upstream);
  try {
    const tools: UpstreamToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await conn.client.listTools(cursor ? { cursor } : undefined, { timeout: 15_000 });
      for (const t of page.tools) tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
      cursor = page.nextCursor;
    } while (cursor && tools.length < 5_000);
    return tools;
  } finally {
    await conn.close();
  }
}

/** プロトコル上のエラー（引数の誤りなど）なら接続は生きている。通信の失敗なら作り直す */
function isConnectionBroken(err: unknown): boolean {
  if (err instanceof McpError) return err.code === ErrorCode.ConnectionClosed;
  return true;
}

interface PoolEntry {
  conn: Promise<UpstreamConnection>;
  sessionId: string;
  lastUsed: number;
  expiresAt: number;
}

/**
 * 実行用の MCP クライアント。Agent のセッション × 配下のサーバーごとに 1 本つなぐ。
 * ブラウザの状態（ログイン・開いているページ）をセッションごとに分けるため（CRT-06）。
 */
export class UpstreamSessionPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly now: () => number;

  constructor(
    private readonly connect: UpstreamConnector,
    private readonly logger: Logger,
    private readonly opts: { idleMs: number; callTimeoutMs?: number; now?: () => number },
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  get size(): number {
    return this.entries.size;
  }

  async callTool(
    grant: SessionGrant,
    upstream: RuntimeUpstreamMcp,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const key = `${grant.session_id}\u0000${upstream.name}`;
    let entry = this.entries.get(key);
    if (!entry) {
      const created: PoolEntry = {
        conn: this.connect(upstream),
        sessionId: grant.session_id,
        lastUsed: this.now(),
        expiresAt: Date.parse(grant.expires_at),
      };
      created.conn.catch(() => {
        if (this.entries.get(key) === created) this.entries.delete(key);
      });
      this.entries.set(key, created);
      entry = created;
    }
    entry.lastUsed = this.now();
    entry.expiresAt = Date.parse(grant.expires_at);

    try {
      const conn = await entry.conn;
      const result = await conn.client.callTool({ name: toolName, arguments: args }, undefined, {
        timeout: this.opts.callTimeoutMs ?? 120_000,
      });
      entry.lastUsed = this.now();
      return {
        content: Array.isArray(result.content) ? (result.content as CallToolResult["content"]) : [],
        ...(result.isError ? { isError: true } : {}),
        ...(result.structuredContent ? { structuredContent: result.structuredContent as Record<string, unknown> } : {}),
      };
    } catch (err) {
      if (isConnectionBroken(err) && this.entries.get(key) === entry) {
        this.entries.delete(key);
        void entry.conn.then((c) => c.close()).catch(() => undefined);
      }
      throw err;
    }
  }

  /** アイドルが長い・許可の期限が切れた接続を閉じる */
  async sweep(): Promise<number> {
    const now = this.now();
    const closing: Promise<void>[] = [];
    for (const [key, entry] of this.entries) {
      if (now - entry.lastUsed > this.opts.idleMs || now >= entry.expiresAt) {
        this.entries.delete(key);
        closing.push(
          entry.conn
            .then((c) => c.close())
            .catch((err) => this.logger.debug({ err: errorMessage(err) }, "MCP の接続を閉じられませんでした")),
        );
      }
    }
    await Promise.all(closing);
    return closing.length;
  }

  async closeAll(): Promise<void> {
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(all.map((e) => e.conn.then((c) => c.close()).catch(() => undefined)));
  }
}
