import OpenAI from "openai";
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionInputParam,
  AgentSessionItem,
} from "openai/resources/beta/agents/agents";
import type { SessionCreateParamsNonStreaming } from "openai/resources/beta/agents/sessions/sessions";

export type { AgentSession, AgentSessionEvent, AgentSessionInputParam, AgentSessionItem };
export type SessionCreateParams = SessionCreateParamsNonStreaming;

export interface AgentSessionTurnSummary {
  id: string;
  status: string;
  subagent_id: string | null;
  error: { code?: string | null; message?: string | null } | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  created_at: number;
  completed_at: number | null;
}

/**
 * Agent Studio が使う OpenAI Agents API の操作（docs/reference/openai-agents-sdk.md）。
 * 本物（OpenAI）と、ローカル・CI 用の擬似実装を差し替えられるようにする。
 */
export interface AgentsApi {
  createSession(params: SessionCreateParams): Promise<AgentSession>;
  retrieveSession(sessionId: string): Promise<AgentSession>;
  /** ライブのイベント。再送はないため、切れたら retrieveSession で状態を合わせる */
  streamEvents(sessionId: string, signal: AbortSignal): Promise<AsyncIterable<AgentSessionEvent>>;
  sendEvents(sessionId: string, events: AgentSessionInputParam[], idempotencyKey?: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  /** 環境の接続状態（pending / connected / disconnected / expired / failed） */
  retrieveEnvironmentStatus(environmentId: string): Promise<string>;
  /** 新しい順 */
  listRecentItems(sessionId: string, limit: number): Promise<AgentSessionItem[]>;
  /** 新しい順。SSE を取りこぼしたときの状態照合に使う */
  listRecentTurns(sessionId: string, limit: number): Promise<AgentSessionTurnSummary[]>;
  /** セッションの成果物（/workspace/outputs に置かれたファイル） */
  listArtifacts(sessionId: string): Promise<{ id: string; path: string; size_bytes: number }[]>;
  downloadArtifact(sessionId: string, artifactId: string): Promise<Buffer>;
  /** 擬似実装だけ: Runtime が Session Worker の起動を報告したら環境を接続済みにする */
  simulateWorkerConnected?(environmentId: string): void;
  /** 公開 MCP 用の認証情報を OpenAI の vault に保存する（値は Agent Studio に残さない） */
  storeVaultCredential?(input: {
    organizationId: string;
    name: string;
    token: string;
    mcpServerUrl: string;
  }): Promise<{ vaultId: string; credentialId: string }>;
}

export class OpenAiAgentsApi implements AgentsApi {
  constructor(private readonly client: OpenAI) {}

  createSession(params: SessionCreateParams): Promise<AgentSession> {
    return this.client.beta.agents.sessions.create(params);
  }

  retrieveSession(sessionId: string): Promise<AgentSession> {
    return this.client.beta.agents.sessions.retrieve(sessionId);
  }

  async streamEvents(sessionId: string, signal: AbortSignal): Promise<AsyncIterable<AgentSessionEvent>> {
    // SSE は長時間つながるため、既定のタイムアウト（10分）より長くする
    return this.client.beta.agents.sessions.events.stream(sessionId, { signal, timeout: 60 * 60 * 1000 });
  }

  async sendEvents(sessionId: string, events: AgentSessionInputParam[], idempotencyKey?: string): Promise<void> {
    await this.client.beta.agents.sessions.events.create(sessionId, {
      events,
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    try {
      await this.client.beta.agents.sessions.delete(sessionId);
    } catch (e) {
      if (e instanceof OpenAI.NotFoundError) return;
      throw e;
    }
  }

  async retrieveEnvironmentStatus(environmentId: string): Promise<string> {
    return (await this.client.beta.agents.environments.retrieve(environmentId)).status;
  }

  async listArtifacts(sessionId: string): Promise<{ id: string; path: string; size_bytes: number }[]> {
    const out: { id: string; path: string; size_bytes: number }[] = [];
    for await (const a of this.client.beta.agents.sessions.artifacts.list(sessionId, { limit: 100 })) {
      out.push({ id: a.id, path: a.path, size_bytes: a.size_bytes });
      if (out.length >= 200) break;
    }
    return out;
  }

  async downloadArtifact(sessionId: string, artifactId: string): Promise<Buffer> {
    const res = await this.client.beta.agents.sessions.artifacts.content(artifactId, { session_id: sessionId });
    return Buffer.from(await res.arrayBuffer());
  }

  async listRecentItems(sessionId: string, limit: number): Promise<AgentSessionItem[]> {
    const page = await this.client.beta.agents.sessions.items.list(sessionId, { order: "desc", limit });
    return page.data;
  }

  async listRecentTurns(sessionId: string, limit: number): Promise<AgentSessionTurnSummary[]> {
    const page = await this.client.beta.agents.sessions.turns.list(sessionId, { order: "desc", limit });
    return page.data.map((turn) => ({
      id: turn.id,
      status: turn.status,
      subagent_id: turn.subagent_id,
      error: turn.error,
      usage: turn.usage ? { input_tokens: turn.usage.input_tokens, output_tokens: turn.usage.output_tokens } : null,
      created_at: turn.created_at,
      completed_at: turn.completed_at,
    }));
  }

  async storeVaultCredential(input: {
    organizationId: string;
    name: string;
    token: string;
    mcpServerUrl: string;
  }): Promise<{ vaultId: string; credentialId: string }> {
    // 接続先ごとに vault を分ける（ローテーション・削除の単位を接続先にそろえる）
    const vault = await this.client.beta.agents.vaults.create({
      name: `agent-studio-${input.name}`.slice(0, 128),
      metadata: { organization_id: input.organizationId },
    });
    const credential = await this.client.beta.agents.vaults.credentials.create(vault.id, {
      name: input.name.slice(0, 256),
      auth: { type: "static_bearer", token: input.token, mcp_server_url: input.mcpServerUrl },
    });
    return { vaultId: vault.id, credentialId: credential.id };
  }
}
