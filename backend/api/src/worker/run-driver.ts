import { randomBytes, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { outputText } from "openai/lib/agents/output-text";
import {
  TERMINAL_RUN_STATUSES,
  canonicalJson,
  evaluatePolicies,
  requestedRecordCount,
  redactLogText,
  redactLogValue,
  sha256Hex,
  toolCallHash,
  type RunStatus,
  type StartSessionJob,
} from "@agent-studio/contracts";
import type { Deps } from "../application/deps.js";
import { hashToken } from "../application/environments.js";
import { appendRunEvent, setRunStatus } from "../application/run-events.js";
import type { CompiledAgentConfig } from "../domain/manifest-compiler.js";
import { buildSessionCreateParams } from "../domain/session-params.js";
import { inspectArtifact } from "../domain/artifact-security.js";
import { evaluateOrganizationAutoApproval } from "../domain/organization-auto-approval.js";
import { recordAudit } from "../infrastructure/audit.js";
import type { Tx } from "../infrastructure/db/tenant-db.js";
import { artifactPrefix } from "../infrastructure/storage/object-store.js";
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionInputParam,
  AgentsApi,
} from "../infrastructure/openai/agents-api.js";
import type { Logger } from "../logger.js";
import type { StudioFunctionExecutor } from "./studio-functions.js";
import { apiErrorDiagnostic } from "./api-error-diagnostic.js";
import { parseExternalJobResponse } from "./external-jobs.js";

type Outcome = "continue" | "done" | "released";
type RequiredAction = AgentSession["required_actions"][number];

const LEASE_RENEW_MS = 20_000;
const LEASE_SECONDS = 60;
const WATCHDOG_MS = 5_000;
const MAX_STREAM_RECONNECTS = 20;
const MAX_ARTIFACTS = 50;
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

const BROWSER_TOOL_PREFIX = "browser_";

/**
 * 同じRunでevent streamとwatchdogが同時にidleを検知しても、副作用を1回だけ実行する。
 * 完了後は次のidle処理を受け付けるため、承認後や追加入力の再開は妨げない。
 */
export class SingleFlight<T> {
  private current: Promise<T> | null = null;

  run(task: () => Promise<T>): Promise<T> {
    if (this.current) return this.current;
    const operation = task().finally(() => {
      if (this.current === operation) this.current = null;
    });
    this.current = operation;
    return operation;
  }
}

function safeWorkflowToolOutput(output: string): string {
  try {
    return JSON.stringify(redactLogValue(JSON.parse(output))).slice(0, 20_000);
  } catch {
    return redactLogText(output).slice(0, 20_000);
  }
}

export function browserConfigForRun(config: CompiledAgentConfig): StartSessionJob["session"]["browser"] {
  const browserTools = config.runtime_tools.filter((name) => name.startsWith(BROWSER_TOOL_PREFIX) || name === "computer_action");
  if (browserTools.length === 0) return undefined;

  // 接続してよい範囲は Agent の設定で決める。業務の設定値からは推測しない
  const access = config.browser_access ?? { access: "restricted" as const, allowed_domains: [] };
  return {
    enabled: true,
    mode: "public_ephemeral",
    allow_public_web: access.access === "public",
    allowed_domains: access.access === "public" ? [] : [...new Set(access.allowed_domains.map((domain) => domain.toLowerCase()))],
    code_execution_enabled: browserTools.includes("browser_exec_js"),
    computer_actions_enabled: browserTools.includes("computer_action"),
    viewport: { width: 1440, height: 900 },
  };
}

const ENV_STATUS_LABELS: Record<string, string> = {
  pending: "作業環境の準備を待っています",
  ready: "作業環境の準備ができました",
  connected: "作業環境が接続されました",
  disconnected: "作業環境との接続が切れました",
  failed: "作業環境に接続できませんでした",
};

interface DriverState {
  run: { id: string; organization_id: string; status: string; agent_id: string; stage: "staging" | "production"; workflow_run_id: string | null };
  config: CompiledAgentConfig;
  sessionRowId: string;
  openaiSessionId: string;
  environmentId: string | null;
  environmentType: string;
  runtimeId: string | null;
  connected: boolean;
  idle: boolean;
  rootTurnActive: boolean;
  lastTurnError: string | null;
  rootTurnIds: Set<string>;
  handledCalls: Set<string>;
  /** 今のターンで何か操作をしたか。何もせず終わったら利用者への質問とみなす */
  turnDidWork: boolean;
  /** 入力を送ったあとターンが始まったか。始まる前の idle で打ち切らないため */
  turnStarted: boolean;
  callCounts: Map<string, number>;
}

/**
 * 1つの Run を進める（Worker 内）。
 * - Run ごとに OpenAI のセッションを作り、イベントを受け取り、タイムラインに記録する
 * - 入力（初回・追加の指示・承認結果）は、セッションが空いたときに送る
 * - Agent Studio が実行するツール（function tool）は、ポリシーと承認を確認してから結果を返す
 * - 承認待ちになったら、ストリームを離して Run を waiting_approval にする（承認後に再開）
 * - イベントの再送はないため、つなぎ直したときは retrieve で状態を合わせる
 */
export class RunDriver {
  private readonly log: Logger;
  private readonly idleSingleFlight = new SingleFlight<Outcome>();
  private api!: AgentsApi;

  constructor(
    private readonly deps: Deps,
    private readonly functions: StudioFunctionExecutor,
    private readonly runId: string,
    private readonly organizationId: string,
    private readonly shutdown: AbortSignal,
  ) {
    this.log = deps.logger.child({ run_id: runId, organization_id: organizationId });
  }

  async drive(): Promise<void> {
    const lease = setInterval(() => void this.renewLease().catch((e) => this.log.warn({ err: e }, "リースの更新に失敗しました")), LEASE_RENEW_MS);
    try {
      const state = await this.prepare();
      if (!state) return;
      const settings = await this.deps.db.org(this.organizationId, (tx) =>
        tx.organization_openai_settings.findUnique({ where: { organization_id: this.organizationId } }),
      );
      this.log.info({ phase: "session.prepared", session_id: state.openaiSessionId, model: state.config.model,
        openai_project_id: settings?.openai_project_id ?? null, environment_type: state.environmentType,
        browser_access: state.config.browser_access, runtime_tool_count: state.config.runtime_tools.length,
      }, "実行の診断情報");
      await this.loop(state);
    } catch (e) {
      this.log.error({ err: e }, "実行を進められませんでした");
      await this.failRun(e instanceof Error ? e.message : "不明なエラー").catch(() => undefined);
    } finally {
      clearInterval(lease);
      await this.releaseLease().catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------------------
  // 準備（セッションの作成・再開）
  // ---------------------------------------------------------------------------
  private async prepare(): Promise<DriverState | null> {
    const loaded = await this.deps.db.org(this.organizationId, async (tx) => {
      const run = await tx.runs.findUniqueOrThrow({ where: { id: this.runId }, include: { deployment: true } });
      const session = await tx.agent_sessions.findFirst({
        where: { run_id: this.runId, ended_at: null },
        orderBy: { created_at: "desc" },
      });
      return { run, session };
    });
    const { run } = loaded;
    if (TERMINAL_RUN_STATUSES.includes(run.status as RunStatus)) return null;

    const config = run.deployment.compiled_config as unknown as CompiledAgentConfig;
    this.api = await this.deps.agentsApi.forOrganization(this.organizationId);

    const base = {
      run: {
        id: run.id,
        organization_id: run.organization_id,
        status: run.status,
        agent_id: run.deployment.agent_id,
        stage: run.deployment.stage as "staging" | "production",
        workflow_run_id: run.workflow_run_id,
      },
      config,
      idle: false,
      rootTurnActive: false,
      lastTurnError: null,
      rootTurnIds: new Set<string>(),
      handledCalls: new Set<string>(),
      turnDidWork: false,
      turnStarted: false,
      callCounts: new Map<string, number>(),
    };

    if (loaded.session?.openai_session_id) {
      return {
        ...base,
        sessionRowId: loaded.session.id,
        openaiSessionId: loaded.session.openai_session_id,
        environmentId: loaded.session.openai_environment_id,
        environmentType: loaded.session.environment_type,
        runtimeId: loaded.session.runtime_id,
        connected: loaded.session.status === "connected",
      };
    }
    return { ...base, ...(await this.createSession(config, base.run)) };
  }

  private async createSession(config: CompiledAgentConfig, runContext: { agent_id: string; stage: "staging" | "production" }) {
    const env = config.environment;
    const { env: appEnv } = this.deps;
    let gateway: { url: string; sessionToken: string } | undefined;
    let tokenHash: string | null = null;
    let runtimeId: string | null = null;

    const { vaults, sessionRow } = await this.deps.db.org(this.organizationId, async (tx) => {
      if (env.type === "self_hosted") {
        const runtime = await tx.runtimes.findFirst({ where: { id: env.runtime_id, organization_id: this.organizationId } });
        if (!runtime || (runtime.status !== "active" && runtime.status !== "degraded")) {
          throw new Error("実行環境の Runtime が接続されていません");
        }
        runtimeId = runtime.id;
        if (config.runtime_tools.length > 0) {
          if (!runtime.gateway_url) throw new Error("Runtime の Tool Gateway の接続先が分かりません");
          // このセッション専用のトークン。平文は OpenAI に渡す Agent 設定にだけ入れ、DB にはハッシュだけ保存する
          const sessionToken = `asst_${randomBytes(32).toString("base64url")}`;
          gateway = { url: runtime.gateway_url, sessionToken };
          tokenHash = hashToken(sessionToken);
        }
      }

      const vaults = new Map<string, { vaultId: string; credentialId: string | null }>();
      const connectionIds = config.service_mcp_tools.map((s) => s.connection_id).filter((id): id is string => Boolean(id));
      if (connectionIds.length > 0) {
        const connections = await tx.connections.findMany({ where: { id: { in: connectionIds }, organization_id: this.organizationId } });
        for (const c of connections) {
          if (!c.secret_locator) continue;
          const [vaultId, credentialId] = c.secret_locator.split(":");
          if (vaultId) vaults.set(c.id, { vaultId, credentialId: credentialId ?? null });
        }
      }
      // 連携サービスとして登録した MCP は、この Stage に紐づけた Connection から認証情報を引く。
      const mcpConnectorIds = config.service_mcp_tools
        .filter((s) => !s.connection_id && s.connector_id)
        .map((s) => s.connector_id!);
      if (mcpConnectorIds.length > 0) {
        const links = await tx.agent_connection_links.findMany({
          where: {
            organization_id: this.organizationId,
            agent_id: runContext.agent_id,
            stage: runContext.stage,
            connector_id: { in: [...new Set(mcpConnectorIds)] },
          },
          include: { connection: true },
        });
        for (const link of links) {
          if (link.connection.status !== "connected" || !link.connection.secret_locator) continue;
          const [vaultId, credentialId] = link.connection.secret_locator.split(":");
          if (vaultId) vaults.set(link.connector_id, { vaultId, credentialId: credentialId ?? null });
        }
      }

      const sessionRow = await tx.agent_sessions.create({
        data: {
          organization_id: this.organizationId,
          run_id: this.runId,
          environment_type: env.type,
          runtime_id: runtimeId,
          token_hash: tokenHash,
          allowed_tools: config.runtime_tools as Prisma.InputJsonValue,
          policies: config.policies as unknown as Prisma.InputJsonValue,
          expires_at: new Date(Date.now() + appEnv.SESSION_MAX_LIFETIME_MINUTES * 60 * 1000),
        },
      });
      const run = await tx.runs.findUniqueOrThrow({ where: { id: this.runId } });
      await setRunStatus(tx, run, "provisioning", { started_at: new Date() });
      return { vaults, sessionRow };
    });

    const run = await this.deps.db.org(this.organizationId, (tx) => tx.runs.findUniqueOrThrow({ where: { id: this.runId } }));
    const params = buildSessionCreateParams(config, {
      ...(gateway ? { gateway } : {}),
      vaults,
      metadata: {
        organization_id: this.organizationId,
        run_id: this.runId,
        deployment_id: run.deployment_id,
        agent_studio_session_id: sessionRow.id,
      },
    });
    const session = await this.api.createSession(params);
    const environmentId = session.environment.type === "none" ? null : session.environment.id;

    await this.deps.db.org(this.organizationId, async (tx) => {
      await tx.agent_sessions.update({
        where: { id: sessionRow.id },
        data: {
          openai_session_id: session.id,
          openai_environment_id: environmentId,
          status: env.type === "self_hosted" ? "waiting_worker" : env.type === "none" ? "connected" : "waiting_worker",
        },
      });
      if (env.type === "self_hosted" && session.environment.type === "self_hosted") {
        await this.enqueueStartSession(tx, sessionRow.id, session.id, session.environment.id, session.environment.remote_url, runtimeId!, tokenHash, config);
      }
    });

    return {
      sessionRowId: sessionRow.id,
      openaiSessionId: session.id,
      environmentId,
      environmentType: env.type,
      runtimeId,
      connected: env.type === "none",
    };
  }

  /** Runtime に Session Worker の起動を依頼する（初回と、環境の再接続が必要なとき） */
  private async enqueueStartSession(
    tx: Tx,
    sessionRowId: string,
    openaiSessionId: string,
    environmentId: string,
    remoteUrl: string,
    runtimeId: string,
    tokenHash: string | null,
    config: CompiledAgentConfig,
  ) {
    const { env } = this.deps;
    const browser = browserConfigForRun(config);
    const session = await tx.agent_sessions.findUniqueOrThrow({ where: { id: sessionRowId } });
    const payload: Omit<StartSessionJob, "job_id"> = {
      type: "start_session",
      session: {
        session_id: sessionRowId,
        run_id: this.runId,
        // ツールを使わない Agent でも Gateway 側の照合が失敗するよう、推測できない値を入れる
        token_hash: tokenHash ?? (await sha256Hex(randomUUID())),
        allowed_tools: config.runtime_tools,
        policies: config.policies,
        expires_at: (session.expires_at ?? new Date(Date.now() + env.SESSION_MAX_LIFETIME_MINUTES * 60_000)).toISOString(),
        openai_session_id: openaiSessionId,
        environment_id: environmentId,
        remote_url: remoteUrl,
        max_lifetime_minutes: env.SESSION_MAX_LIFETIME_MINUTES,
        idle_timeout_minutes: env.SESSION_IDLE_TIMEOUT_MINUTES,
        ...(browser ? { browser } : {}),
      },
    };
    await tx.runtime_jobs.create({
      data: {
        organization_id: this.organizationId,
        runtime_id: runtimeId,
        session_id: sessionRowId,
        type: "start_session",
        payload: payload as unknown as Prisma.InputJsonValue,
      },
    });
    await appendRunEvent(tx, { id: this.runId, organization_id: this.organizationId }, "environment.status", "Runtime に作業環境の起動を依頼しました", {});
  }

  // ---------------------------------------------------------------------------
  // イベントの受信
  // ---------------------------------------------------------------------------
  private async loop(state: DriverState): Promise<void> {
    for (let attempt = 0; attempt < MAX_STREAM_RECONNECTS; attempt++) {
      if (this.shutdown.aborted) return;
      const controller = new AbortController();
      const onShutdown = () => controller.abort();
      this.shutdown.addEventListener("abort", onShutdown);
      let decided: Outcome | null = null;

      const watchdog = setInterval(() => {
        void this.watchdog(state)
          .then((o) => {
            if (o !== "continue" && !decided) {
              decided = o;
              controller.abort();
            }
          })
          .catch((e) => this.log.warn({ ...apiErrorDiagnostic(e), phase: "watchdog", session_id: state.openaiSessionId }, "状態の確認に失敗しました"));
      }, WATCHDOG_MS);

      let phase = "stream.open";
      const attemptStarted = Date.now();
      this.log.info({ phase, attempt, session_id: state.openaiSessionId }, "イベント接続を開始します");
      try {
        // ストリームを開いてから状態を合わせる（開く前に起きたことを取りこぼさないため）
        const stream = await this.api.streamEvents(state.openaiSessionId, controller.signal);
        phase = "session.reconcile";
        const initial = await this.reconcile(state);
        if (initial !== "continue") {
          decided = initial;
          return;
        }
        phase = "stream.receive";
        for await (const event of stream) {
          const outcome = await this.handleEvent(state, event);
          if (outcome !== "continue") {
            decided = outcome;
            return;
          }
        }
      } catch (e) {
        if (decided || this.shutdown.aborted) return;
        const diagnostic = { ...apiErrorDiagnostic(e), phase, attempt, elapsed_ms: Date.now() - attemptStarted,
          session_id: state.openaiSessionId, model: state.config.model,
          connected: state.connected, turn_started: state.turnStarted, turn_did_work: state.turnDidWork,
        };
        this.log.error(diagnostic, "OpenAIの処理でエラーが発生しました");
        await this.deps.db.org(this.organizationId, (tx) => appendRunEvent(tx, state.run, "error",
          `OpenAIエラー [${diagnostic.code ?? "unknown"}] ${diagnostic.message}${diagnostic.request_id ? `（Request ID: ${diagnostic.request_id}）` : ""}`,
          diagnostic,
        ));
        // Toolが成功していても、その後にモデル/streamが失敗したターンを成功扱いしない。
        // 再接続後にidleならonIdleがこのエラーでRunをfailedへ確定する。
        state.lastTurnError = diagnostic.message;
        await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 15_000)));
      } finally {
        clearInterval(watchdog);
        this.shutdown.removeEventListener("abort", onShutdown);
        controller.abort();
      }
      if (decided) return;
    }
    await this.failRun("OpenAI との接続が繰り返し切れました");
  }

  /** つなぎ直したときに、現在の状態を取り込む */
  private async reconcile(state: DriverState): Promise<Outcome> {
    const session = await this.api.retrieveSession(state.openaiSessionId);
    this.log.info({ phase: "session.reconcile", session_id: state.openaiSessionId, api_status: session.status,
      has_error: Boolean(session.error), turn_started: state.turnStarted, turn_did_work: state.turnDidWork,
    }, "再接続時のセッション状態");
    if (!state.connected && state.environmentId && state.environmentType !== "none") {
      const status = await this.api.retrieveEnvironmentStatus(state.environmentId).catch(() => "pending");
      if (status === "connected") await this.onEnvironment(state, "connected", null);
    }
    switch (session.status) {
      case "failed":
        await this.failRun(session.error ?? "セッションが失敗しました");
        return "done";
      case "requires_action":
        state.idle = false;
        return this.handleRequiredActions(state, session.required_actions);
      case "idle":
        state.idle = true;
        state.rootTurnActive = false;
        return this.onIdle(state);
      default:
        state.idle = false;
        state.rootTurnActive = true;
        return "continue";
    }
  }

  private async handleEvent(state: DriverState, event: AgentSessionEvent): Promise<Outcome> {
    if (!event.type.includes("delta")) {
      this.log.info({ phase: "session.event", session_id: state.openaiSessionId, event_type: event.type }, "OpenAIイベントを受信しました");
    }
    switch (event.type) {
      case "agent.session.environment.pending":
      case "agent.session.environment.ready":
      case "agent.session.environment.connected":
      case "agent.session.environment.disconnected":
      case "agent.session.environment.failed":
        return this.onEnvironment(state, event.environment.status, event.environment.error?.message ?? null);

      case "agent.session.turn.created":
        if (event.turn.subagent_id === null) {
          state.rootTurnIds.add(event.turn_id);
          state.rootTurnActive = true;
          state.turnDidWork = false;
          state.turnStarted = true;
          state.idle = false;
          if (state.run.status !== "running") await this.setStatus(state, "running");
        }
        return "continue";

      case "agent.session.turn.item.done":
        await this.onItemDone(state, event);
        return "continue";

      case "agent.session.requires_action":
        state.idle = false;
        state.turnDidWork = true;
        return this.handleRequiredActions(state, event.session.required_actions);

      case "agent.session.turn.completed":
      case "agent.session.turn.failed":
      case "agent.session.turn.cancelled":
        if (event.turn.subagent_id === null) {
          state.rootTurnActive = false;
          if (event.type === "agent.session.turn.failed") {
            state.lastTurnError = event.turn.error?.message ?? "エージェントの処理が失敗しました";
          }
          if (event.usage) await this.addUsage(event.usage.input_tokens, event.usage.output_tokens);
        }
        return "continue";

      case "agent.session.idle":
        state.idle = true;
        if (state.rootTurnActive) return "continue";
        return this.onIdle(state);

      case "agent.session.failed":
        await this.failRun(event.session.error ?? "セッションが失敗しました");
        return "done";

      default:
        return "continue";
    }
  }

  private async onEnvironment(state: DriverState, status: string, error: string | null): Promise<Outcome> {
    await this.deps.db.org(this.organizationId, async (tx) => {
      if (status === "connected" || status === "failed") {
        await tx.agent_sessions.update({ where: { id: state.sessionRowId }, data: { status: status === "connected" ? "connected" : "failed" } });
      }
      await appendRunEvent(tx, state.run, "environment.status", error ? `${ENV_STATUS_LABELS[status] ?? status}: ${error}` : (ENV_STATUS_LABELS[status] ?? status), { status });
    });
    if (status === "failed") {
      await this.failRun(`作業環境に接続できませんでした${error ? `: ${error}` : ""}`);
      return "done";
    }
    if (status === "connected" && !state.connected) {
      state.connected = true;
      if (state.run.status === "provisioning") await this.setStatus(state, "running");
      if (state.idle && !state.rootTurnActive) return this.onIdle(state);
    }
    return "continue";
  }

  private async onItemDone(state: DriverState, event: Extract<AgentSessionEvent, { type: "agent.session.turn.item.done" }>) {
    const item = event.item;
    const fromRoot = event.turn_id === null || state.rootTurnIds.size === 0 || state.rootTurnIds.has(event.turn_id);
    await this.deps.db.org(this.organizationId, async (tx) => {
      switch (item.type) {
        case "message":
          if (item.phase === "final_answer" && fromRoot) {
            const text = outputText(item);
            // 再接続でturn.createdを取り逃しても、最終回答はターンが進んだ証拠になる。
            state.turnStarted = true;
            if (text.trim()) state.turnDidWork = true;
            await tx.runs.update({ where: { id: this.runId }, data: { output: text } });
            await appendRunEvent(tx, state.run, "message", "エージェントの回答", { role: "assistant", text });
          }
          break;
        case "mcp_call": {
          state.turnDidWork = true;
          const failed = item.status !== "completed" || Boolean(item.error);
          if (failed) {
            await tx.runs.updateMany({ where: { id: this.runId, outcome: "pending" }, data: { outcome: "completed_with_errors" } });
          }
          await appendRunEvent(tx, state.run, "tool.call", `${item.name} を${failed ? "実行できませんでした" : "実行しました"}`, {
            kind: "mcp",
            server_label: item.server_label,
            name: item.name,
            status: item.status,
            error: item.error ?? null,
          });
          if (!failed && state.run.workflow_run_id && typeof item.output === "string") {
            await appendRunEvent(tx, state.run, "tool.result", `${item.name} の構造化結果をWorkflowへ渡しました`, {
              kind: "mcp",
              name: item.server_label,
              remote_name: item.name,
              output: safeWorkflowToolOutput(item.output),
            });
          }
          break;
        }
        case "command_execution":
          state.turnDidWork = true;
          await appendRunEvent(tx, state.run, "tool.call", `コマンドを実行しました: ${item.command.slice(0, 120)}`, {
            kind: "command",
            command: item.command.slice(0, 2000),
            exit_code: item.exit_code,
            duration_ms: item.duration_ms,
          });
          break;
        case "web_search_call":
          state.turnDidWork = true;
          await appendRunEvent(tx, state.run, "tool.call", "Web を検索しました", { kind: "web_search", action: item.action });
          break;
        default:
          break;
      }
    });
  }

  /** セッションが空いた: 入力を送るか、承認待ちにするか、完了にする */
  private onIdle(state: DriverState): Promise<Outcome> {
    return this.idleSingleFlight.run(() => this.processIdle(state));
  }

  private async processIdle(state: DriverState): Promise<Outcome> {
    // self_hosted は Session Worker が接続するまで入力を送らない
    if (state.environmentType === "self_hosted" && !state.connected) return "continue";

    const pending = await this.deps.db.org(this.organizationId, (tx) =>
      tx.run_inputs.findMany({ where: { run_id: this.runId, status: "pending" }, orderBy: { created_at: "asc" } }),
    );
    if (pending.length > 0) {
      const events: AgentSessionInputParam[] = [
        {
          type: "agent.session.input.message",
          input: pending.map((p) => ({ role: "user" as const, content: [{ type: "input_text" as const, text: p.input }] })),
        },
      ];
      // 同じ入力を二重に送らないよう、入力の ID から冪等キーを作る
      const inputStarted = Date.now();
      this.log.info({ phase: "input.send.start", session_id: state.openaiSessionId, input_count: pending.length }, "指示の送信を開始します");
      await this.api.sendEvents(state.openaiSessionId, events, `run-input-${pending.map((p) => p.id).join(",")}`.slice(0, 250));
      this.log.info({ phase: "input.send.done", session_id: state.openaiSessionId, elapsed_ms: Date.now() - inputStarted }, "指示の送信が完了しました");
      await this.deps.db.org(this.organizationId, (tx) =>
        tx.run_inputs.updateMany({ where: { id: { in: pending.map((p) => p.id) } }, data: { status: "sent", sent_at: new Date() } }),
      );
      state.idle = false;
      state.turnStarted = false;
      state.lastTurnError = null;
      return "continue";
    }

    if (state.lastTurnError) {
      await this.failRun(state.lastTurnError);
      return "done";
    }

    const pendingApprovals = await this.deps.db.org(this.organizationId, (tx) =>
      tx.approvals.count({ where: { run_id: this.runId, status: "pending" } }),
    );
    if (pendingApprovals > 0) {
      await this.setStatus(state, "waiting_approval");
      return "released";
    }

    // 入力を送ったあとターンが始まる前の idle では何も判断しない（開始を待つ）
    if (!state.turnStarted) return "continue";

    // 何も操作せずにターンが終わったのは、Agent が利用者へ聞き返したとき。
    // ここで終わらせると返答できなくなるので、返答待ちにして再開できる状態で離す。
    if (!state.turnDidWork) {
      this.log.warn({ phase: "idle.waiting_input", session_id: state.openaiSessionId, turn_started: state.turnStarted,
        turn_did_work: state.turnDidWork, has_turn_error: Boolean(state.lastTurnError),
      }, "操作実績のないターンを返答待ちにします");
      await this.saveArtifacts(state);
      await this.setStatus(state, "waiting_input");
      return "released";
    }

    await this.saveArtifacts(state);
    await this.completeRun();
    return "done";
  }

  /**
   * 成果物（/workspace/outputs）を S3 に保存する（RUN-06）。セッションを削除すると取り出せなくなるため、完了にする前に行う。
   * 失敗しても実行は完了にする（タイムラインに記録する）。
   */
  private async saveArtifacts(state: DriverState) {
    const bucket = this.deps.env.ARTIFACTS_BUCKET;
    if (!bucket || state.environmentType === "none") return;
    try {
      const artifacts = (await this.api.listArtifacts(state.openaiSessionId)).filter((a) => a.size_bytes <= MAX_ARTIFACT_BYTES).slice(0, MAX_ARTIFACTS);
      if (artifacts.length === 0) return;
      const prefix = artifactPrefix(this.organizationId, this.runId);
      const saved: Array<ReturnType<typeof inspectArtifact> & { objectKey: string; sizeBytes: number }> = [];
      for (const a of artifacts) {
        const body = await this.api.downloadArtifact(state.openaiSessionId, a.id);
        const inspected = inspectArtifact(a.path, body);
        const objectKey = `${prefix}${inspected.path}`;
        if (inspected.scanStatus === "passed") await this.deps.objects.put(bucket, objectKey, body, inspected.mimeType);
        saved.push({ ...inspected, objectKey, sizeBytes: body.byteLength });
      }
      await this.deps.db.org(this.organizationId, async (tx) => {
        for (const artifact of saved) {
          await tx.run_artifacts.upsert({
            where: { organization_id_run_id_path: { organization_id: this.organizationId, run_id: this.runId, path: artifact.path } },
            create: {
              organization_id: this.organizationId, run_id: this.runId, path: artifact.path, object_key: artifact.objectKey,
              mime_type: artifact.mimeType, size_bytes: artifact.sizeBytes, sha256: artifact.sha256,
              scan_status: artifact.scanStatus, scan_engine: artifact.scanEngine, source: "openai_session",
              retained_until: new Date(Date.now() + 30 * 24 * 60 * 60_000),
            },
            update: {
              object_key: artifact.objectKey, mime_type: artifact.mimeType, size_bytes: artifact.sizeBytes, sha256: artifact.sha256,
              scan_status: artifact.scanStatus, scan_engine: artifact.scanEngine, retained_until: new Date(Date.now() + 30 * 24 * 60 * 60_000),
            },
          });
        }
        await appendRunEvent(tx, state.run, "message", `成果物を ${saved.filter((artifact) => artifact.scanStatus === "passed").length} 件保存しました`, {
          role: "system",
          text: saved.map((artifact) => `${artifact.path} (${artifact.scanStatus})`).join("\n"),
        });
      });
    } catch (e) {
      this.log.warn({ err: e }, "成果物を保存できませんでした");
      await this.deps.db
        .org(this.organizationId, (tx) => appendRunEvent(tx, state.run, "error", "成果物を保存できませんでした", {}))
        .catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------------------
  // function tool（studio_function）
  // ---------------------------------------------------------------------------
  private async handleRequiredActions(state: DriverState, actions: RequiredAction[]): Promise<Outcome> {
    let waiting = false;
    const results: AgentSessionInputParam[] = [];

    for (const action of actions) {
      if (action.type === "environment_connection") {
        await this.requestReconnect(state);
        continue;
      }
      if (state.handledCalls.has(action.call_id)) continue;
      const result = await this.executeFunctionCall(state, action);
      if (result === "waiting") {
        waiting = true;
        continue;
      }
      state.handledCalls.add(action.call_id);
      results.push({ type: "agent.session.input.tool_result", turn_id: action.turn_id, call_id: action.call_id, ...result });
    }

    if (results.length > 0) {
      await this.api.sendEvents(state.openaiSessionId, results, `tool-results-${results.map((r) => (r as { call_id: string }).call_id).join(",")}`.slice(0, 250));
    }
    if (waiting) {
      await this.setStatus(state, "waiting_approval");
      return "released";
    }
    if (state.run.status === "requires_action" || state.run.status === "waiting_approval") await this.setStatus(state, "running");
    return "continue";
  }

  private async executeFunctionCall(
    state: DriverState,
    action: Extract<RequiredAction, { type: "function_call" }>,
  ): Promise<{ success: true; output: string } | { success: false; error: string } | "waiting"> {
    const tool = state.config.function_tools.find((f) => f.name === action.name);
    if (!tool) return { success: false, error: `ツール ${action.name} はこのエージェントでは使えません` };

    let args: Record<string, unknown>;
    try {
      const raw = typeof action.arguments === "string" ? JSON.parse(action.arguments) : action.arguments;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
      args = raw as Record<string, unknown>;
    } catch {
      return { success: false, error: "引数の形式が正しくありません" };
    }

    const callsSoFar = state.callCounts.get(tool.name) ?? 0;
    const decision = evaluatePolicies(state.config.policies, { tool: tool.name, args, now: new Date(), callsSoFar });
    let approvedBeforeExecution = false;

    if (decision.action === "deny") {
      await this.recordToolEvent(state, tool.name, `${tool.name} はポリシーにより実行されませんでした`, { reason: decision.reason });
      return { success: false, error: decision.reason };
    }

    if (decision.action === "require_approval") {
      const approval = await this.deps.db.org(this.organizationId, async (tx) => {
        const existing = await tx.approvals.findFirst({ where: { run_id: this.runId, source: "studio_function", call_id: action.call_id } });
        if (existing) return existing;
        const destination = tool.spec.handler === "http_api" ? new URL(tool.spec.base_url) : null;
        const auto = await evaluateOrganizationAutoApproval(tx, this.organizationId, {
          actionKind: tool.spec.handler === "http_api" ? "api_call" : "tool_call",
          stage: state.run.stage,
          operation: tool.name,
          risk: tool.risk,
          host: destination?.hostname ?? null,
          method: tool.spec.handler === "http_api" ? tool.spec.method : null,
          requestedRecords: requestedRecordCount(args),
          now: new Date(),
        });
        if (auto.policy && auto.decision.action === "auto_approve") {
          const now = new Date();
          const created = await tx.approvals.create({
            data: {
              organization_id: this.organizationId,
              run_id: this.runId,
              session_id: state.sessionRowId,
              source: "studio_function",
              call_id: action.call_id,
              tool: tool.name,
              args_hash: await toolCallHash(tool.name, args),
              args_preview: canonicalJson(redactLogValue(args)).slice(0, 4000),
              reason: decision.reason,
              status: "approved",
              expires_at: new Date(now.getTime() + decision.timeout_minutes * 60_000),
              decided_at: now,
              auto_approved: true,
              auto_approval_policy_id: auto.policy.id,
              auto_approval_policy_version: auto.policy.version,
              auto_approval_reason: auto.decision.reason,
            },
          });
          await appendRunEvent(tx, state.run, "approval.decided", `${tool.name} を組織Policyが自動承認しました`, {
            approval_id: created.id,
            tool: tool.name,
            policy_id: auto.policy.id,
            policy_version: auto.policy.version,
            reason: auto.decision.reason,
          });
          await recordAudit(tx, {
            organizationId: this.organizationId,
            actorType: "system",
            actorId: "organization_policy",
            action: "approval.auto_approve",
            targetType: "approval",
            targetId: created.id,
            detail: { tool: tool.name, policy_id: auto.policy.id, policy_version: auto.policy.version, reason: auto.decision.reason },
          });
          return created;
        }
        const created = await tx.approvals.create({
          data: {
            organization_id: this.organizationId,
            run_id: this.runId,
            session_id: state.sessionRowId,
            source: "studio_function",
            call_id: action.call_id,
            tool: tool.name,
            args_hash: await toolCallHash(tool.name, args),
            args_preview: canonicalJson(redactLogValue(args)).slice(0, 4000),
            reason: decision.reason,
            expires_at: new Date(Date.now() + decision.timeout_minutes * 60_000),
          },
        });
        await appendRunEvent(tx, state.run, "approval.requested", `${tool.name} の実行に承認が必要です: ${decision.reason}`, {
          approval_id: created.id,
          tool: tool.name,
          args_preview: created.args_preview,
        });
        return created;
      });
      if (approval.status === "pending") return "waiting";
      if (approval.status !== "approved") {
        return { success: false, error: approval.status === "denied" ? "承認者がこの操作を却下しました" : "承認されませんでした" };
      } else {
        await this.deps.db.org(this.organizationId, (tx) =>
          tx.approvals.update({ where: { id: approval.id }, data: { status: "consumed", consumed_at: new Date() } }),
        );
        approvedBeforeExecution = true;
      }
    }

    state.callCounts.set(tool.name, callsSoFar + 1);
    try {
      const output = await this.functions.execute(this.organizationId, tool, args, {
        agentId: state.run.agent_id,
        stage: state.run.stage,
        runId: this.runId,
      });
      await this.recordToolEvent(state, tool.name, `${tool.name} を実行しました`, { status: "completed" });
      if (state.run.workflow_run_id) {
        await this.deps.db.org(this.organizationId, (tx) =>
          appendRunEvent(tx, state.run, "tool.result", `${tool.name} の構造化結果をWorkflowへ渡しました`, {
            kind: "function",
            name: tool.name,
            output: safeWorkflowToolOutput(output),
          }),
        );
      }
      await this.captureExternalJob(state, tool.name, tool.connector_id, output);
      return { success: true, output };
    } catch (e) {
      const message = e instanceof Error ? e.message : "ツールの実行に失敗しました";
      await this.recordToolEvent(state, tool.name, `${tool.name} を実行できませんでした`, { status: "failed", error: message });
      return { success: false, error: approvedBeforeExecution ? `承認後の実行に失敗しました: ${message}` : message };
    }
  }

  private async recordToolEvent(state: DriverState, name: string, summary: string, data: Record<string, unknown>) {
    await this.deps.db.org(this.organizationId, async (tx) => {
      if (data.status === "failed") {
        await tx.runs.updateMany({
          where: { id: this.runId, outcome: "pending" },
          data: { outcome: "completed_with_errors" },
        });
      }
      await appendRunEvent(tx, state.run, "tool.call", summary, { kind: "function", name, ...data });
    });
  }

  private async captureExternalJob(state: DriverState, toolName: string, connectorId: string | null, output: string) {
    if (!connectorId || toolName !== "publish_post") return;
    const parsed = parseExternalJobResponse(output);
    if (!parsed?.providerJobId) return;
    await this.deps.db.org(this.organizationId, async (tx) => {
      const job = await tx.external_jobs.upsert({
        where: {
          organization_id_connector_id_provider_job_id: {
            organization_id: this.organizationId,
            connector_id: connectorId,
            provider_job_id: parsed.providerJobId!,
          },
        },
        create: {
          organization_id: this.organizationId,
          run_id: this.runId,
          connector_id: connectorId,
          source_tool: toolName,
          poll_tool: "get_job",
          provider_job_id: parsed.providerJobId!,
          status: parsed.status,
          response: parsed.response as Prisma.InputJsonValue,
          next_poll_at: new Date(Date.now() + 2_000),
        },
        update: { response: parsed.response as Prisma.InputJsonValue },
      });
      await appendRunEvent(tx, state.run, "external.job", `外部サービスで投稿処理を受け付けました（Job ${job.provider_job_id}）`, {
        job_id: job.id,
        provider_job_id: job.provider_job_id,
        status: job.status,
      });
    });
  }

  /** OpenAI から環境の再接続を求められた: Session Worker の起動を依頼し直す */
  private async requestReconnect(state: DriverState) {
    if (state.environmentType !== "self_hosted" || !state.runtimeId || !state.environmentId) return;
    await this.deps.db.org(this.organizationId, async (tx) => {
      const pendingStart = await tx.runtime_jobs.count({
        where: { session_id: state.sessionRowId, type: "start_session", status: { in: ["pending", "leased"] } },
      });
      if (pendingStart > 0) return;
      const session = await this.api.retrieveSession(state.openaiSessionId);
      if (session.environment.type !== "self_hosted") return;
      const row = await tx.agent_sessions.findUniqueOrThrow({ where: { id: state.sessionRowId } });
      state.connected = false;
      await tx.agent_sessions.update({ where: { id: row.id }, data: { status: "waiting_worker" } });
      await this.enqueueStartSession(tx, row.id, state.openaiSessionId, state.environmentId!, session.environment.remote_url, state.runtimeId!, row.token_hash, state.config);
    });
  }

  // ---------------------------------------------------------------------------
  // 監視・終了
  // ---------------------------------------------------------------------------
  /** 5秒ごと: 中止・Runtime 側の失敗・Worker の起動タイムアウト・新しい入力を確認する */
  private async watchdog(state: DriverState): Promise<Outcome> {
    const { run, session, pendingInputs } = await this.deps.db.org(this.organizationId, async (tx) => ({
      run: await tx.runs.findUniqueOrThrow({ where: { id: this.runId } }),
      session: await tx.agent_sessions.findUniqueOrThrow({ where: { id: state.sessionRowId } }),
      pendingInputs: await tx.run_inputs.count({ where: { run_id: this.runId, status: "pending" } }),
    }));

    if (run.status === "cancelled") {
      if (state.rootTurnActive) {
        await this.api.sendEvents(state.openaiSessionId, [{ type: "agent.session.input.cancel" }]).catch(() => undefined);
      }
      return "done";
    }
    if (TERMINAL_RUN_STATUSES.includes(run.status as RunStatus)) return "done";
    if (session.status === "failed") {
      await this.failRun("作業環境を用意できませんでした");
      return "done";
    }
    if (session.status === "waiting_worker" && !state.connected) {
      const waitedMs = Date.now() - session.created_at.getTime();
      if (waitedMs > this.deps.env.WORKER_CONNECT_TIMEOUT_MINUTES * 60_000) {
        await this.failRun("作業環境が時間内に接続されませんでした。Runtime の状態を確認してください");
        return "done";
      }
    }
    if (pendingInputs > 0 && state.idle && !state.rootTurnActive) return this.onIdle(state);
    return "continue";
  }

  private async setStatus(state: DriverState, status: RunStatus) {
    await this.deps.db.org(this.organizationId, async (tx) => {
      const run = await tx.runs.findUniqueOrThrow({ where: { id: this.runId } });
      if (run.status === status || TERMINAL_RUN_STATUSES.includes(run.status as RunStatus)) return;
      await setRunStatus(tx, run, status);
    });
    state.run.status = status;
  }

  private async addUsage(input: number, output: number) {
    await this.deps.db.org(this.organizationId, async (tx) => {
      const run = await tx.runs.findUniqueOrThrow({ where: { id: this.runId } });
      const prev = (run.usage as { input_tokens?: number; output_tokens?: number } | null) ?? {};
      await tx.runs.update({
        where: { id: this.runId },
        data: { usage: { input_tokens: (prev.input_tokens ?? 0) + input, output_tokens: (prev.output_tokens ?? 0) + output } },
      });
    });
  }

  private async completeRun() {
    await this.deps.db.org(this.organizationId, async (tx) => {
      const run = await tx.runs.findUniqueOrThrow({ where: { id: this.runId } });
      if (TERMINAL_RUN_STATUSES.includes(run.status as RunStatus)) return;
      await setRunStatus(tx, run, "completed", run.outcome === "pending" ? { outcome: "succeeded" } : {});
    });
  }

  private async failRun(message: string) {
    await this.deps.db.org(this.organizationId, async (tx) => {
      const run = await tx.runs.findUniqueOrThrow({ where: { id: this.runId } });
      if (TERMINAL_RUN_STATUSES.includes(run.status as RunStatus)) return;
      await setRunStatus(tx, run, "failed", { error: message.slice(0, 2000) }, message.slice(0, 200));
    });
  }

  private async renewLease() {
    await this.deps.db.org(this.organizationId, (tx) =>
      tx.runs.updateMany({
        where: { id: this.runId, stream_lease_owner: this.deps.env.WORKER_ID },
        data: { stream_lease_until: new Date(Date.now() + LEASE_SECONDS * 1000) },
      }),
    );
  }

  private async releaseLease() {
    await this.deps.db.org(this.organizationId, (tx) =>
      tx.runs.updateMany({
        where: { id: this.runId, stream_lease_owner: this.deps.env.WORKER_ID },
        data: { stream_lease_owner: null, stream_lease_until: null },
      }),
    );
  }
}
