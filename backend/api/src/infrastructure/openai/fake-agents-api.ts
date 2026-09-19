import { randomUUID } from "node:crypto";
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionInputParam,
  AgentSessionItem,
  AgentsApi,
  SessionCreateParams,
} from "./agents-api.js";

/**
 * ローカル開発・CI 用の擬似 Agents API。OpenAI を呼ばずに、実行の流れ（環境の接続、
 * function tool の呼び出し、最終回答、中止）を再現する。
 *
 * 入力に [[call:<ツール名> {"引数":...}]] を含めると、その function tool を呼ぶ。
 * [[fail]] を含めるとターンを失敗させる。
 */
interface FakeSession {
  id: string;
  environment: AgentSession["environment"];
  status: AgentSession["status"];
  requiredActions: AgentSession["required_actions"];
  subscribers: Set<EventQueue>;
  items: AgentSessionItem[];
  functionTools: Set<string>;
  turnSeq: number;
  pending: { turnId: string; callId: string; name: string } | null;
  metadata: Record<string, string>;
  createdAt: number;
  connected: boolean;
  artifacts: { id: string; path: string; data: Buffer }[];
}

class EventQueue implements AsyncIterable<AgentSessionEvent> {
  private readonly buffer: AgentSessionEvent[] = [];
  private waiter: ((r: IteratorResult<AgentSessionEvent>) => void) | null = null;
  private closed = false;

  push(e: AgentSessionEvent) {
    if (this.closed) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: e, done: false });
    } else {
      this.buffer.push(e);
    }
  }

  close() {
    this.closed = true;
    this.waiter?.({ value: undefined, done: true });
    this.waiter = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentSessionEvent> {
    return {
      next: () => {
        const e = this.buffer.shift();
        if (e) return Promise.resolve({ value: e, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiter = resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

const CALL_PATTERN = /\[\[call:([a-z][a-z0-9_]*)\s*(\{.*?\})?\]\]/s;

export class FakeAgentsApi implements AgentsApi {
  private readonly sessions = new Map<string, FakeSession>();

  constructor(private readonly environmentConnectDelayMs = 300) {}

  async createSession(params: SessionCreateParams): Promise<AgentSession> {
    const id = `fake_sess_${randomUUID()}`;
    const envType = params.environment.type;
    const environment = (
      envType === "self_hosted"
        ? {
            type: "self_hosted",
            id: `fake_env_${randomUUID()}`,
            capability_directories: [],
            remote_url: "wss://fake-agents.invalid/environments",
            workspace_directory: "/workspace",
          }
        : envType === "openai_hosted"
          ? { type: "openai_hosted", id: `fake_env_${randomUUID()}`, capability_directories: [], files: [], network: { access: "disabled", allowed_domains: [] }, packages: { npm: [], python: [], system: [] }, plugins: [], skills: [] }
          : { type: "none" }
    ) as AgentSession["environment"];

    const functionTools = new Set(
      (params.agent?.tools ?? []).filter((t) => t.type === "function").map((t) => (t as { name: string }).name),
    );
    const session: FakeSession = {
      id,
      environment,
      status: "idle",
      requiredActions: [],
      subscribers: new Set(),
      items: [],
      functionTools,
      turnSeq: 0,
      pending: null,
      metadata: params.metadata ?? {},
      createdAt: Date.now(),
      connected: false,
      artifacts: [],
    };
    this.sessions.set(id, session);

    if (environment.type !== "none") {
      this.emitLater(session, [{ type: "agent.session.environment.pending", session_id: id, turn_id: null, environment: this.envState(session, "pending") }]);
      // self_hosted は、Runtime が Session Worker の起動を報告するまで接続しない（本物と同じ流れ）
      if (environment.type === "openai_hosted") {
        setTimeout(() => this.connect(session), this.environmentConnectDelayMs);
      }
    }
    return this.snapshot(session);
  }

  async listArtifacts(sessionId: string): Promise<{ id: string; path: string; size_bytes: number }[]> {
    return this.sessions.get(sessionId)?.artifacts.map((a) => ({ id: a.id, path: a.path, size_bytes: a.data.length })) ?? [];
  }

  async downloadArtifact(sessionId: string, artifactId: string): Promise<Buffer> {
    const a = this.get(sessionId).artifacts.find((x) => x.id === artifactId);
    if (!a) throw new Error("artifact not found");
    return a.data;
  }

  simulateWorkerConnected(environmentId: string): void {
    const session = [...this.sessions.values()].find((s) => (s.environment as { id?: string }).id === environmentId);
    if (session) setTimeout(() => this.connect(session), this.environmentConnectDelayMs);
  }

  private connect(session: FakeSession) {
    if (session.connected) return;
    session.connected = true;
    this.emit(session, { type: "agent.session.environment.connected", session_id: session.id, turn_id: null, environment: this.envState(session, "connected") });
  }

  private envState(session: FakeSession, status: string) {
    return { id: (session.environment as { id: string }).id, type: session.environment.type, status, error: null };
  }

  async retrieveSession(sessionId: string): Promise<AgentSession> {
    return this.snapshot(this.get(sessionId));
  }

  async streamEvents(sessionId: string, signal: AbortSignal): Promise<AsyncIterable<AgentSessionEvent>> {
    const session = this.get(sessionId);
    const queue = new EventQueue();
    session.subscribers.add(queue);
    signal.addEventListener("abort", () => {
      session.subscribers.delete(queue);
      queue.close();
    });
    return queue;
  }

  async sendEvents(sessionId: string, events: AgentSessionInputParam[]): Promise<void> {
    const session = this.get(sessionId);
    for (const event of events) {
      if (event.type === "agent.session.input.message") {
        const text = event.input
          .flatMap((m) => m.content)
          .map((c) => (c.type === "input_text" ? c.text : ""))
          .join("\n");
        this.startTurn(session, text);
      } else if (event.type === "agent.session.input.tool_result") {
        if (!session.pending || session.pending.callId !== event.call_id) {
          throw new Error(`Unknown pending tool call: ${event.call_id}`);
        }
        const { turnId, name } = session.pending;
        session.pending = null;
        session.requiredActions = [];
        session.status = "in_progress";
        const result = event.success ? String(event.output ?? "") : `エラー: ${event.error ?? ""}`;
        this.finishTurn(session, turnId, `ツール ${name} の結果: ${result}`);
      } else if (event.type === "agent.session.input.cancel") {
        const turnId = session.pending?.turnId ?? `turn_${session.turnSeq}`;
        session.pending = null;
        session.requiredActions = [];
        session.status = "idle";
        this.emitLater(session, [
          { type: "agent.session.turn.cancelled", session_id: session.id, turn_id: turnId, turn: this.turn(session, turnId, "cancelled"), usage: null },
          { type: "agent.session.idle", session: this.snapshot(session) },
        ]);
      }
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const q of session.subscribers) q.close();
    this.sessions.delete(sessionId);
  }

  async listRecentItems(sessionId: string, limit: number): Promise<AgentSessionItem[]> {
    return [...this.get(sessionId).items].reverse().slice(0, limit);
  }

  async retrieveEnvironmentStatus(environmentId: string): Promise<string> {
    const session = [...this.sessions.values()].find((s) => (s.environment as { id?: string }).id === environmentId);
    return session?.connected ? "connected" : "pending";
  }

  async storeVaultCredential(): Promise<{ vaultId: string; credentialId: string }> {
    return { vaultId: `fake_vault_${randomUUID()}`, credentialId: `fake_cred_${randomUUID()}` };
  }

  // ---------------------------------------------------------------------------

  private startTurn(session: FakeSession, text: string) {
    const turnId = `turn_${++session.turnSeq}`;
    session.status = "in_progress";
    const events: unknown[] = [
      { type: "agent.session.in_progress", session: this.snapshot(session) },
      { type: "agent.session.turn.created", session_id: session.id, turn_id: turnId, turn: this.turn(session, turnId, "in_progress") },
    ];

    if (text.includes("[[fail]]")) {
      session.status = "idle";
      events.push(
        { type: "agent.session.turn.failed", session_id: session.id, turn_id: turnId, turn: { ...this.turn(session, turnId, "failed"), error: { code: "server_error", message: "擬似的な失敗" } }, usage: null },
        { type: "agent.session.idle", session: this.snapshot(session) },
      );
      this.emitLater(session, events);
      return;
    }

    const call = CALL_PATTERN.exec(text);
    if (call && session.functionTools.has(call[1]!)) {
      const callId = `call_${randomUUID()}`;
      const name = call[1]!;
      const args = call[2] ?? "{}";
      session.pending = { turnId, callId, name };
      session.status = "requires_action";
      session.requiredActions = [{ type: "function_call", call_id: callId, turn_id: turnId, name, arguments: args }];
      events.push(
        { type: "agent.session.turn.item.added", session_id: session.id, turn_id: turnId, output_index: 0, item: { type: "function_call", id: `item_${callId}`, call_id: callId, name, arguments: args, status: "in_progress", turn_id: turnId } },
        { type: "agent.session.requires_action", session: this.snapshot(session) },
      );
      this.emitLater(session, events);
      return;
    }

    const artifact = /\[\[artifact:([\w.-]+)\]\]/.exec(text);
    if (artifact) {
      session.artifacts.push({ id: `art_${randomUUID()}`, path: `/workspace/outputs/${artifact[1]}`, data: Buffer.from(`擬似的な成果物: ${artifact[1]}`) });
    }
    this.emitLater(session, events);
    this.finishTurn(session, turnId, `（テスト応答）次の依頼を受け付けました: ${text.slice(0, 200)}`);
  }

  private finishTurn(session: FakeSession, turnId: string, answer: string) {
    const item = {
      type: "message",
      id: `msg_${randomUUID()}`,
      role: "assistant",
      phase: "final_answer",
      status: "completed",
      content: [{ type: "output_text", text: answer, annotations: [] }],
      turn_id: turnId,
    };
    session.items.push(item as unknown as AgentSessionItem);
    const usage = {
      input_tokens: 120,
      output_tokens: 40,
      total_tokens: 160,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    };
    setTimeout(() => {
      session.status = "idle";
      for (const e of [
        { type: "agent.session.turn.item.done", session_id: session.id, turn_id: turnId, output_index: 0, item },
        { type: "agent.session.turn.completed", session_id: session.id, turn_id: turnId, turn: { ...this.turn(session, turnId, "completed"), usage }, usage },
        { type: "agent.session.idle", session: this.snapshot(session) },
      ]) {
        this.emit(session, e);
      }
    }, 50);
  }

  private turn(session: FakeSession, turnId: string, status: string) {
    const now = Math.floor(Date.now() / 1000);
    return {
      id: turnId,
      object: "agent.session.turn",
      session_id: session.id,
      agent_id: "fake_agent",
      subagent_id: null,
      status,
      error: null,
      usage: null,
      created_at: now,
      started_at: now,
      completed_at: status === "in_progress" ? null : now,
    };
  }

  private snapshot(session: FakeSession): AgentSession {
    return {
      id: session.id,
      object: "agent.session",
      status: session.status,
      environment: session.environment,
      required_actions: session.requiredActions,
      error: null,
      usage: null,
      metadata: session.metadata,
      vault_ids: [],
      created_at: Math.floor(Date.now() / 1000),
      last_active_at: Math.floor(Date.now() / 1000),
    } as unknown as AgentSession;
  }

  private emitLater(session: FakeSession, events: unknown[]) {
    setTimeout(() => {
      for (const e of events) this.emit(session, e);
    }, 10);
  }

  private emit(session: FakeSession, event: unknown) {
    const withId = { event_id: `evt_${randomUUID()}`, ...(event as object) } as AgentSessionEvent;
    for (const q of session.subscribers) q.push(withId);
  }

  private get(sessionId: string): FakeSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`fake session not found: ${sessionId}`);
    return s;
  }
}
