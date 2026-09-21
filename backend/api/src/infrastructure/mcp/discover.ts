import { inputSchemaSchema, type DiscoveredMcpToolDto } from "@agent-studio/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { preconditionFailed } from "../../domain/errors.js";
import { assertPublicUrl } from "../http/public-url.js";

const CONNECT_TIMEOUT_MS = 15_000;
const MAX_TOOLS = 200;

interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

/**
 * 公開 MCP サーバーへ接続し、申告されている操作の一覧を取る（登録画面の入力補助）。
 * 認証は行わない。認証が必要なサーバーは失敗するので、利用者が手で登録する。
 */
export async function discoverMcpTools(serverUrl: string): Promise<DiscoveredMcpToolDto[]> {
  // Control Plane の VPC やメタデータへ到達させない（service MCP は公開されている前提）
  try {
    await assertPublicUrl(serverUrl);
  } catch {
    throw preconditionFailed("インターネットから接続できるMCPサーバーのURLを指定してください。社内ネットワークのサーバーはSelf-hosted Runtimeで扱います");
  }

  const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
  const client = new Client({ name: "agent-studio", version: "0.1.0" }, { capabilities: {} });
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  } catch {
    throw preconditionFailed("MCPサーバーに接続できませんでした。URLを確認してください。認証が必要なサーバーは、操作を手で登録してください");
  }

  try {
    const tools: DiscoveredMcpToolDto[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT_MS });
      for (const tool of page.tools) {
        const annotations = tool.annotations as ToolAnnotations | undefined;
        if (JSON.stringify(tool.inputSchema).length > 100_000) {
          throw preconditionFailed(`MCP操作 ${tool.name} のinputSchemaが大きすぎます`);
        }
        const inputSchema = inputSchemaSchema.safeParse(tool.inputSchema);
        if (!inputSchema.success) {
          throw preconditionFailed(`MCP操作 ${tool.name} のinputSchemaがobject形式ではありません`);
        }
        tools.push({
          name: tool.name,
          description: (tool.description ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 1000),
          input_schema: inputSchema.data,
          // annotations は任意。申告がなければ不明として扱い、こちらで決めつけない
          read_only: typeof annotations?.readOnlyHint === "boolean" ? annotations.readOnlyHint : null,
          destructive: annotations?.destructiveHint === true,
        });
        if (tools.length >= MAX_TOOLS) return tools;
      }
      cursor = page.nextCursor;
    } while (cursor);
    if (tools.length === 0) throw preconditionFailed("このMCPサーバーは操作を1つも公開していません");
    return tools;
  } finally {
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}
