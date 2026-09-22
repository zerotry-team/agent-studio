import type { ServerType } from "@hono/node-server";
import {
  heartbeatRequestSchema,
  runtimeToolCatalogEntrySchema,
  type JobResultRequest,
  type RuntimeJob,
  type RuntimeToolCatalogEntry,
} from "@agent-studio/contracts";
import { AuditBuffer } from "./audit-buffer.js";
import type { ControllerConfig } from "./config.js";
import type { GrantStore } from "./grants.js";
import { createInternalApp, startInternalServer } from "./internal-server.js";
import { JobHandler } from "./jobs.js";
import type { SessionLauncher } from "./launcher.js";
import { browserAccessToken, type BrowserLauncher } from "./browser-launcher.js";
import type { Logger } from "./logger.js";
import { errorInfo } from "./logger.js";
import { SessionMonitor } from "./monitor.js";
import type { ControllerSecrets } from "./secrets.js";
import type { WorkspaceExecutor } from "./workspace-executor.js";
import type { GitPublisher } from "./git-publisher.js";
import type { BuilderResultCollector } from "./builder-result-collector.js";
import type { BrowserProfileBroker } from "./browser-profile-broker.js";
import type { EcsBuilderWorkspaces } from "./ecs-builder.js";
import type { AdapterInstaller } from "./adapters.js";
import type { ObjectStore } from "./object-store.js";
import {
  RegistrationFailedError,
  RuntimeNotRegisteredError,
  RuntimeRevokedError,
  StudioApiError,
  type RuntimeAuth,
  type StudioApi,
} from "./studio-client.js";

export interface ControllerDeps {
  config: ControllerConfig;
  logger: Logger;
  auth: RuntimeAuth;
  studio: StudioApi;
  grants: GrantStore;
  launcher: SessionLauncher;
  browserLauncher: BrowserLauncher;
  workspaceExecutor: WorkspaceExecutor;
  gitPublisher: GitPublisher;
  builderResultCollector: BuilderResultCollector;
  browserProfileBroker: BrowserProfileBroker;
  secrets: ControllerSecrets;
  controllerVersion: string;
  builderWorkspaces?: Pick<EcsBuilderWorkspaces, "prepare">;
  adapterInstaller?: Pick<AdapterInstaller, "install" | "list" | "bundle">;
  /** Builder 作業領域の受け渡し先（ECS） */
  artifactStore?: ObjectStore;
  fetchImpl?: typeof fetch;
}

// 本番の外向き HTTP 経路では、設定上の CloudFront / ALB timeout より前に
// 15 秒で 504 になることがある。十分な余白を持たせ、正常な空レスポンスで
// 次の poll に移れる長さにする。
const JOB_WAIT_SECONDS = 10;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MONITOR_INTERVAL_MS = 15_000;
const AUDIT_FLUSH_INTERVAL_MS = 5_000;
const NOT_REGISTERED_RETRY_MS = 60_000;
const REVOKED_RETRY_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_INFLIGHT_JOBS = 16;
const SHUTDOWN_GRACE_MS = 20_000;

/**
 * Runtime Controller 本体。
 * 認証 → activeSessions の引き継ぎ → ジョブの long-poll を繰り返し、
 * 並行してハートビート・Worker の監視・監査イベントの送信を行う。
 */
export class Controller {
  readonly jobs: JobHandler;
  readonly monitor: SessionMonitor;
  readonly audit: AuditBuffer;
  private readonly abort = new AbortController();
  private readonly aborted = new Promise<void>((resolve) => this.abort.signal.addEventListener("abort", () => resolve(), { once: true }));
  private readonly inflight = new Set<Promise<void>>();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly busy = new Set<string>();
  private server: ServerType | undefined;
  private loop: Promise<void> | undefined;
  private reconciled = false;
  private stopping = false;

  constructor(private readonly deps: ControllerDeps) {
    const { config, logger, grants, launcher, browserLauncher, workspaceExecutor, gitPublisher, builderResultCollector, browserProfileBroker, studio, secrets } = deps;
    this.jobs = new JobHandler({
      grants,
      launcher,
      browserLauncher,
      workspaceExecutor,
      gitPublisher,
      builderResultCollector,
      browserProfileBroker,
      ...(deps.builderWorkspaces ? { builderWorkspaces: deps.builderWorkspaces } : {}),
      ...(deps.adapterInstaller ? { adapterInstaller: deps.adapterInstaller } : {}),
      studio,
      secrets,
      logger,
      gatewayPublicUrl: config.gatewayPublicUrl,
      limits: {
        maxConcurrentSessions: config.maxConcurrentSessions,
        sessionMaxLifetimeMinutes: config.sessionMaxLifetimeMinutes,
      },
    });
    this.monitor = new SessionMonitor({ grants, launcher, browserLauncher, studio, logger });
    this.audit = new AuditBuffer((events) => studio.sendAudit(events), logger, {
      isPermanentFailure: (err) => err instanceof StudioApiError && (err.status === 400 || err.status === 422),
    });
  }

  async start(): Promise<void> {
    const { config, logger, grants, auth, studio } = this.deps;
    const app = createInternalApp({
      grants,
      studio,
      audit: this.audit,
      refreshActiveSessions: async () => {
        grants.syncFromActive(await studio.activeSessions(), config.sessionMaxLifetimeMinutes);
      },
      health: () => ({
        auth_state: auth.state,
        active_sessions: grants.activeWorkerCount(),
        pending_audit_events: this.audit.size,
      }),
      logger,
      ...(this.deps.builderWorkspaces && this.deps.artifactStore ? { builderArtifacts: this.deps.artifactStore } : {}),
      ...(this.deps.adapterInstaller ? { adapters: this.deps.adapterInstaller } : {}),
    });
    this.server = startInternalServer(app, config.internalPort);
    logger.info({ port: config.internalPort, launcher: this.deps.launcher.kind }, "Runtime Controller を起動しました");

    this.every(HEARTBEAT_INTERVAL_MS, "heartbeat", () => this.heartbeat());
    this.every(MONITOR_INTERVAL_MS, "monitor", () => this.monitor.tick());
    this.every(AUDIT_FLUSH_INTERVAL_MS, "audit", () => this.audit.flush());
    this.loop = this.runLoop();
  }

  /** SIGTERM: ジョブの取得をやめる。実行中の Session Worker は止めない */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.deps.logger.info("停止します（実行中の Session Worker はそのまま残します）");
    this.abort.abort();
    for (const t of this.timers) clearInterval(t);
    await this.loop?.catch(() => undefined);
    if (this.inflight.size > 0) {
      await Promise.race([Promise.allSettled([...this.inflight]), new Promise((r) => setTimeout(r, SHUTDOWN_GRACE_MS))]);
    }
    await this.audit.flush().catch(() => undefined);
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private every(ms: number, name: string, fn: () => Promise<void>): void {
    const run = async () => {
      if (this.busy.has(name) || this.stopping) return;
      this.busy.add(name);
      try {
        await fn();
      } catch (err) {
        this.deps.logger.warn({ err: errorInfo(err), task: name }, "定期処理に失敗しました");
      } finally {
        this.busy.delete(name);
      }
    };
    this.timers.push(setInterval(() => void run(), ms));
  }

  /** stop() で中断できる sleep */
  private sleep(ms: number): Promise<void> {
    const signal = this.abort.signal;
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async runLoop(): Promise<void> {
    const { auth, logger, studio, grants } = this.deps;
    let backoff = 1_000;
    const failAndBackoff = async () => {
      await this.sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    };

    while (!this.stopping) {
      try {
        await auth.getAccessToken();
        grants.suspended = false;
      } catch (err) {
        if (err instanceof RuntimeNotRegisteredError) {
          logger.warn(err.message);
          await this.sleep(NOT_REGISTERED_RETRY_MS);
        } else if (err instanceof RegistrationFailedError) {
          logger.error(`${err.message}。60 秒後に再試行します`);
          await this.sleep(NOT_REGISTERED_RETRY_MS);
        } else if (err instanceof RuntimeRevokedError) {
          grants.suspended = true;
          await this.sleep(REVOKED_RETRY_MS);
        } else {
          logger.warn({ err: errorInfo(err), retry_in_ms: backoff }, "アクセストークンを取得できませんでした");
          await failAndBackoff();
        }
        continue;
      }

      if (!this.reconciled) {
        try {
          await this.reconcile();
          this.reconciled = true;
          void this.heartbeat().catch((err) => logger.warn({ err: errorInfo(err) }, "ハートビートを送れませんでした"));
        } catch (err) {
          logger.warn({ err: errorInfo(err) }, "実行中のセッションを引き継げませんでした。再試行します");
          await failAndBackoff();
          continue;
        }
      }
      if (auth.environmentKeySyncPending) await this.syncEnvironmentKey();

      if (this.inflight.size >= MAX_INFLIGHT_JOBS) {
        await Promise.race([...this.inflight, this.aborted]);
        continue;
      }

      let next;
      try {
        next = await studio.nextJob(JOB_WAIT_SECONDS, this.abort.signal);
        backoff = 1_000;
      } catch (err) {
        if (this.stopping) break;
        if (err instanceof RuntimeRevokedError) {
          grants.suspended = true;
          continue;
        }
        logger.warn({ err: errorInfo(err), retry_in_ms: backoff }, "ジョブを取得できませんでした");
        await failAndBackoff();
        continue;
      }

      if (next.kind === "job") {
        this.dispatch(next.job);
      } else if (next.kind === "invalid") {
        logger.error({ job_id: next.jobId, issues: next.message }, "解釈できないジョブを受け取りました");
        if (next.jobId) {
          const jobId = next.jobId;
          this.track(
            this.reportJobResult(jobId, {
              status: "failed",
              error: "このバージョンの Runtime Controller は、このジョブに対応していません",
            }).then(() => undefined),
          );
        }
      }
    }
  }

  private track(p: Promise<void>): void {
    const tracked = p.finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
  }

  private dispatch(job: RuntimeJob): void {
    this.deps.logger.info({ job_id: job.job_id, job_type: job.type }, "ジョブを受け取りました");
    this.track(
      (async () => {
        const result = await this.jobs.handle(job);
        const accepted = await this.reportJobResult(job.job_id, result);
        if (accepted && result.status === "succeeded" && job.type === "publish_builder_branch") {
          await this.deps.gitPublisher.cleanup?.(job);
        }
      })().catch((err) => this.deps.logger.error({ err: errorInfo(err), job_id: job.job_id }, "ジョブの処理中にエラーが発生しました")),
    );
  }

  private async reportJobResult(jobId: string, result: JobResultRequest): Promise<boolean> {
    const log = this.deps.logger.child({ job_id: jobId, status: result.status });
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await this.deps.studio.jobResult(jobId, result);
        if (result.status === "failed") log.warn({ error: result.error }, "ジョブが失敗しました");
        else log.info("ジョブが完了しました");
        return true;
      } catch (err) {
        if (err instanceof StudioApiError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 429) {
          log.error({ err: errorInfo(err) }, "ジョブの結果を Agent Studio が受け付けませんでした");
          return false;
        }
        log.warn({ err: errorInfo(err), attempt }, "ジョブの結果を送れませんでした");
        await new Promise((r) => setTimeout(r, 2_000 * attempt));
      }
    }
    log.error("ジョブの結果を送れないまま諦めました");
    return false;
  }

  /** 再起動時: Agent Studio の activeSessions と、実行中の Worker を突き合わせて引き継ぐ */
  async reconcile(): Promise<void> {
    const { studio, grants, launcher, browserLauncher, logger, config } = this.deps;
    const sessions = await studio.activeSessions();
    let adopted = 0;
    for (const grant of sessions) {
      if (grants.get(grant.session_id)?.worker) continue;
      let task = null;
      try {
        task = await launcher.findRunning(grant.session_id);
      } catch (err) {
        logger.warn({ err: errorInfo(err), session_id: grant.session_id }, "Session Worker を探せませんでした");
      }
      if (task) {
        const extra: Parameters<GrantStore["upsert"]>[1] = {
          maxLifetimeMinutes: config.sessionMaxLifetimeMinutes,
          worker: { status: "running", taskArn: task.taskArn, startedAt: task.startedAt ?? new Date() },
        };
        if (grant.browser || grant.allowed_tools.some((tool) => tool.startsWith("browser_") || tool === "computer_action")) {
          try {
            const browserTask = await browserLauncher.findRunning(grant.session_id);
            if (browserTask) {
              const accessToken = browserAccessToken(grant.session_id, grant.run_id);
              const endpoint = browserLauncher.endpoint(browserTask, accessToken);
              if (!endpoint) throw new Error("Browser endpointを解決できませんでした");
              const mode = grant.browser?.mode ?? "public_ephemeral";
              const allowedDomains = grant.browser?.allowed_domains ?? [];
              const browserConfig = {
                enabled: true as const,
                mode,
                allowed_domains: allowedDomains,
                allow_public_web: grant.browser?.allow_public_web ?? false,
                code_execution_enabled: mode === "public_ephemeral" && grant.allowed_tools.includes("browser_exec_js"),
                computer_actions_enabled: false,
                viewport: { width: 1440, height: 900 },
              };
              grant.browser = { endpoint, mode, allowed_domains: allowedDomains, allow_public_web: browserConfig.allow_public_web };
              extra.browser = {
                status: "running",
                taskArn: browserTask.taskArn,
                startedAt: browserTask.startedAt ?? new Date(),
                accessToken,
                config: browserConfig,
              };
            }
          } catch (err) {
            logger.warn({ err: errorInfo(err), session_id: grant.session_id }, "Browser Session Worker を探せませんでした");
          }
        }
        grants.upsert(grant, extra);
        adopted++;
      }
    }
    grants.syncFromActive(sessions, config.sessionMaxLifetimeMinutes);
    this.monitor.enableOrphanSweep();
    await this.monitor.sweepOrphans();
    logger.info({ active_sessions: sessions.length, adopted_workers: adopted }, "実行中のセッションを引き継ぎました");
  }

  private async syncEnvironmentKey(): Promise<void> {
    try {
      const key = await this.deps.studio.environmentKey();
      if (key) await this.deps.secrets.saveEnvironmentKey(key);
      this.deps.auth.environmentKeySyncPending = false;
    } catch (err) {
      this.deps.logger.warn({ err: errorInfo(err) }, "環境キーを取り直せませんでした");
    }
  }

  private async fetchCatalog(): Promise<RuntimeToolCatalogEntry[]> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    try {
      const res = await fetchImpl(this.deps.config.gatewayCatalogUrl, { signal: AbortSignal.timeout(3_000) });
      if (!res.ok) return [];
      const json: unknown = await res.json();
      if (!Array.isArray(json)) return [];
      return json.flatMap((entry) => {
        const parsed = runtimeToolCatalogEntrySchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      });
    } catch {
      return [];
    }
  }

  /**
   * Builder は通常 Run と同じ exec-server Session Worker で実行する。
   * - Docker: 同じ隔離 volume で結果回収と branch 公開まで行う
   * - ECS: S3 の保存先があるときだけ（作業領域を Tool Gateway 経由で受け渡す）
   * noop launcher では Environment 接続が成立しないため広告しない。
   */
  private capabilities(): Array<"builder_workspace" | "adapter_delivery"> {
    const kind = this.deps.launcher.kind;
    const out: Array<"builder_workspace" | "adapter_delivery"> = [];
    if (kind === "docker" || (kind === "ecs" && this.deps.builderWorkspaces)) out.push("builder_workspace");
    if (this.deps.adapterInstaller && kind !== "noop") out.push("adapter_delivery");
    return out;
  }

  async heartbeat(): Promise<void> {
    const { auth, studio, grants, config, controllerVersion } = this.deps;
    if (auth.state !== "active") return;
    const body = heartbeatRequestSchema.parse({
      controller_version: controllerVersion,
      gateway_url: config.gatewayPublicUrl,
      active_sessions: grants.activeSessionIds().slice(0, 1000),
      tools: (await this.fetchCatalog()).slice(0, 500),
      capabilities: this.capabilities(),
    });
    await studio.heartbeat(body);
  }
}
