import {
  RUNTIME_API,
  activeSessionsResponseSchema,
  approvalResponseSchema,
  environmentKeyResponseSchema,
  registerResponseSchema,
  runtimeJobSchema,
  tokenResponseSchema,
  type ApprovalRequest,
  type ApprovalResponse,
  type HeartbeatRequest,
  type JobResultRequest,
  type RuntimeJob,
  type SessionEventRequest,
  type SessionGrant,
  type ToolAuditEvent,
} from "@agent-studio/contracts";
import type { z } from "zod";
import type { IdentitySigner } from "./identity.js";
import type { Logger } from "./logger.js";
import { errorInfo } from "./logger.js";
import type { ControllerSecrets } from "./secrets.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Agent Studio がエラーを返した（HTTP 4xx / 5xx） */
export class StudioApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "StudioApiError";
  }
}

/** Agent Studio に到達できなかった（DNS・接続・タイムアウトなど） */
export class StudioNetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StudioNetworkError";
  }
}

/** 未登録で、手元に使える Bootstrap Token も無い */
export class RuntimeNotRegisteredError extends Error {
  override name = "RuntimeNotRegisteredError";
}

/** Runtime が Agent Studio 側で失効している（§8.4） */
export class RuntimeRevokedError extends Error {
  override name = "RuntimeRevokedError";
}

/** Bootstrap Token での登録が拒否された */
export class RegistrationFailedError extends Error {
  override name = "RegistrationFailedError";
}

export const ERROR_CODE_NOT_REGISTERED = "runtime_not_registered";
export const ERROR_CODE_REVOKED = "runtime_revoked";

function extractError(json: unknown): { code?: string; message?: string } {
  if (!json || typeof json !== "object") return {};
  const obj = json as Record<string, unknown>;
  const inner = obj.error && typeof obj.error === "object" ? (obj.error as Record<string, unknown>) : obj;
  return {
    code: typeof inner.code === "string" ? inner.code : typeof obj.error === "string" ? obj.error : undefined,
    message: typeof inner.message === "string" ? inner.message : undefined,
  };
}

export interface StudioRequestOptions {
  body?: unknown;
  token?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Agent Studio の Runtime API への素の HTTP クライアント（認証は RuntimeAuth が扱う） */
export class StudioHttp {
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly baseUrl: string,
    private readonly userAgent: string,
    fetchImpl?: FetchLike,
    private readonly defaultTimeoutMs = 15_000,
  ) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async request(method: "GET" | "POST", path: string, opts: StudioRequestOptions = {}): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": this.userAgent };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;

    const timeout = AbortSignal.timeout(opts.timeoutMs ?? this.defaultTimeoutMs);
    const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal,
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      throw new StudioNetworkError(`Agent Studio に接続できませんでした（${method} ${path}）: ${errorInfo(err).message}`, {
        cause: err,
      });
    }

    const text = await res.text().catch(() => "");
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const { code, message } = extractError(json);
      throw new StudioApiError(res.status, code, message ?? `Agent Studio がエラーを返しました（HTTP ${res.status}）`);
    }
    return json;
  }
}

function parseResponse<T extends z.ZodType>(schema: T, json: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new StudioApiError(502, "invalid_response", `Agent Studio の応答の形式が正しくありません（${what}）`);
  return parsed.data;
}

export type AuthState = "starting" | "active" | "waiting_bootstrap" | "registration_failed" | "revoked" | "unavailable";

export interface RuntimeAuthDeps {
  http: StudioHttp;
  signIdentity: IdentitySigner;
  secrets: ControllerSecrets;
  controllerVersion: string;
  logger: Logger;
  now?: () => number;
  /** 期限のこれだけ前に更新する */
  refreshMarginMs?: number;
}

/**
 * Runtime のアクセストークンの取得・更新（§8.1）。
 * 未登録なら Bootstrap Token で登録し、環境キーを保存して Bootstrap Token を消す。
 */
export class RuntimeAuth {
  private token: { value: string; expiresAt: number } | undefined;
  private inflight: Promise<string> | undefined;
  private _state: AuthState = "starting";
  runtimeId: string | undefined;
  organizationId: string | undefined;
  /** 登録時に環境キーを保存できなかった（後で environment-key から取り直す） */
  environmentKeySyncPending = false;

  constructor(private readonly deps: RuntimeAuthDeps) {}

  get state(): AuthState {
    return this._state;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private setState(state: AuthState): void {
    if (this._state !== state) this.deps.logger.info({ from: this._state, to: state }, "認証の状態が変わりました");
    this._state = state;
  }

  async getAccessToken(): Promise<string> {
    const t = this.token;
    if (t && this.now() < t.expiresAt - (this.deps.refreshMarginMs ?? 120_000)) return t.value;
    this.inflight ??= this.authenticate().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** 401 を受けたトークンを捨てる（別の要求がすでに更新していれば何もしない） */
  invalidate(token: string): void {
    if (this.token?.value === token) this.token = undefined;
  }

  markRevoked(): void {
    this.token = undefined;
    if (this._state !== "revoked") this.deps.logger.error("この Runtime は Agent Studio 側で失効しています。ジョブの取得を停止します");
    this.setState("revoked");
  }

  private accept(res: { runtime_id: string; organization_id: string; access_token: string; expires_in: number }): string {
    this.token = { value: res.access_token, expiresAt: this.now() + res.expires_in * 1000 };
    this.runtimeId = res.runtime_id;
    this.organizationId = res.organization_id;
    this.setState("active");
    return res.access_token;
  }

  private async authenticate(): Promise<string> {
    const identity = await this.deps.signIdentity();
    try {
      const json = await this.deps.http.request("POST", RUNTIME_API.token, { body: { identity } });
      return this.accept(parseResponse(tokenResponseSchema, json, "token"));
    } catch (err) {
      if (err instanceof StudioApiError && err.status === 403) {
        if (err.code === ERROR_CODE_NOT_REGISTERED) return this.register();
        if (err.code === ERROR_CODE_REVOKED) {
          this.markRevoked();
          throw new RuntimeRevokedError(err.message);
        }
      }
      this.setState("unavailable");
      throw err;
    }
  }

  private async register(): Promise<string> {
    const { secrets, logger } = this.deps;
    const bootstrapToken = await secrets.readBootstrapToken();
    if (!bootstrapToken) {
      this.setState("waiting_bootstrap");
      throw new RuntimeNotRegisteredError(
        "この Runtime はまだ登録されていません。Bootstrap Token をシークレットに登録してください",
      );
    }
    if (bootstrapToken.length < 32 || bootstrapToken.length > 256) {
      this.setState("registration_failed");
      throw new RegistrationFailedError("Bootstrap Token の形式が正しくありません（32〜256 文字）");
    }

    let json: unknown;
    try {
      json = await this.deps.http.request("POST", RUNTIME_API.register, {
        body: {
          bootstrap_token: bootstrapToken,
          identity: await this.deps.signIdentity(),
          controller_version: this.deps.controllerVersion,
        },
      });
    } catch (err) {
      if (err instanceof StudioApiError && err.status >= 400 && err.status < 500) {
        this.setState("registration_failed");
        throw new RegistrationFailedError(`Runtime の登録が拒否されました: ${err.message}`);
      }
      this.setState("unavailable");
      throw err;
    }
    const res = parseResponse(registerResponseSchema, json, "register");

    if (res.environment_key) {
      try {
        await secrets.saveEnvironmentKey(res.environment_key);
      } catch (err) {
        this.environmentKeySyncPending = true;
        logger.error({ err: errorInfo(err) }, "環境キーを保存できませんでした。後で Agent Studio から取り直します");
      }
    }
    await secrets.markBootstrapConsumed();
    logger.info(
      { runtime_id: res.runtime_id, organization_id: res.organization_id, stage: res.stage },
      "Runtime を Agent Studio に登録しました",
    );
    return this.accept(res);
  }
}

export type NextJobResult =
  | { kind: "none" }
  | { kind: "job"; job: RuntimeJob }
  /** このバージョンが解釈できないジョブ（job_id が読めれば失敗として返す） */
  | { kind: "invalid"; jobId?: string; message: string };

/** Controller 内部から使う Agent Studio の API（テストでは差し替える） */
export interface StudioApi {
  heartbeat(body: HeartbeatRequest): Promise<void>;
  nextJob(waitSeconds: number, signal?: AbortSignal): Promise<NextJobResult>;
  jobResult(jobId: string, body: JobResultRequest): Promise<void>;
  sessionEvent(sessionId: string, body: SessionEventRequest): Promise<void>;
  activeSessions(): Promise<SessionGrant[]>;
  createApproval(body: ApprovalRequest): Promise<ApprovalResponse>;
  getApproval(approvalId: string): Promise<ApprovalResponse>;
  consumeApproval(approvalId: string): Promise<ApprovalResponse>;
  sendAudit(events: ToolAuditEvent[]): Promise<void>;
  environmentKey(): Promise<string | null>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** アクセストークン付きで Runtime API を呼ぶ。401 なら一度だけトークンを取り直して再試行する */
export class AgentStudioClient implements StudioApi {
  constructor(
    private readonly http: StudioHttp,
    private readonly auth: RuntimeAuth,
  ) {}

  private async call(method: "GET" | "POST", path: string, opts: Omit<StudioRequestOptions, "token"> = {}): Promise<unknown> {
    const token = await this.auth.getAccessToken();
    try {
      return await this.http.request(method, path, { ...opts, token });
    } catch (err) {
      if (err instanceof StudioApiError && err.status === 401) {
        this.auth.invalidate(token);
        const retryToken = await this.auth.getAccessToken();
        try {
          return await this.http.request(method, path, { ...opts, token: retryToken });
        } catch (retryErr) {
          throw this.mapError(retryErr);
        }
      }
      throw this.mapError(err);
    }
  }

  private mapError(err: unknown): unknown {
    if (err instanceof StudioApiError && err.status === 403 && err.code === ERROR_CODE_REVOKED) {
      this.auth.markRevoked();
      return new RuntimeRevokedError(err.message);
    }
    return err;
  }

  async heartbeat(body: HeartbeatRequest): Promise<void> {
    await this.call("POST", RUNTIME_API.heartbeat, { body });
  }

  async nextJob(waitSeconds: number, signal?: AbortSignal): Promise<NextJobResult> {
    const json = await this.call("GET", `${RUNTIME_API.nextJob}?wait=${waitSeconds}`, {
      signal,
      timeoutMs: (waitSeconds + 15) * 1000,
    });
    const raw = json && typeof json === "object" ? (json as { job?: unknown }).job : undefined;
    if (raw === null || raw === undefined) return { kind: "none" };
    const parsed = runtimeJobSchema.safeParse(raw);
    if (parsed.success) return { kind: "job", job: parsed.data };
    const jobId = (raw as { job_id?: unknown }).job_id;
    return {
      kind: "invalid",
      jobId: typeof jobId === "string" && UUID_RE.test(jobId) ? jobId : undefined,
      message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }

  async jobResult(jobId: string, body: JobResultRequest): Promise<void> {
    await this.call("POST", RUNTIME_API.jobResult(jobId), { body });
  }

  async sessionEvent(sessionId: string, body: SessionEventRequest): Promise<void> {
    await this.call("POST", RUNTIME_API.sessionEvent(sessionId), { body });
  }

  async activeSessions(): Promise<SessionGrant[]> {
    const json = await this.call("GET", RUNTIME_API.activeSessions);
    return parseResponse(activeSessionsResponseSchema, json, "sessions/active").sessions;
  }

  async createApproval(body: ApprovalRequest): Promise<ApprovalResponse> {
    return parseResponse(approvalResponseSchema, await this.call("POST", RUNTIME_API.approvals, { body }), "approvals");
  }

  async getApproval(approvalId: string): Promise<ApprovalResponse> {
    return parseResponse(approvalResponseSchema, await this.call("GET", RUNTIME_API.approval(approvalId)), "approval");
  }

  async consumeApproval(approvalId: string): Promise<ApprovalResponse> {
    return parseResponse(
      approvalResponseSchema,
      await this.call("POST", RUNTIME_API.consumeApproval(approvalId), { body: {} }),
      "approval consume",
    );
  }

  async sendAudit(events: ToolAuditEvent[]): Promise<void> {
    await this.call("POST", RUNTIME_API.audit, { body: { events } });
  }

  async environmentKey(): Promise<string | null> {
    return parseResponse(environmentKeyResponseSchema, await this.call("GET", RUNTIME_API.environmentKey), "environment-key")
      .environment_key;
  }
}
