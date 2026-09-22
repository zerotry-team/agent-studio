import {
  approvalResponseSchema,
  sessionArtifactResponseSchema,
  sessionGrantSchema,
  type ApprovalRequest,
  type ApprovalResponse,
  type SessionArtifactRequest,
  type SessionArtifactResponse,
  type SessionGrant,
  type ToolAuditEvent,
} from "@agent-studio/contracts";

/** Controller の内部 API（127.0.0.1:8081）に届かない・想定外の応答 */
export class ControllerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ControllerError";
  }
}

/** Tool Gateway から使う Controller の API（テストでは差し替える） */
export interface ControllerApi {
  /** 無い・期限切れなら null */
  getGrantByTokenHash(tokenHash: string): Promise<SessionGrant | null>;
  /** 無い・終了済みなら null */
  getGrantBySessionId(sessionId: string): Promise<SessionGrant | null>;
  createApproval(req: ApprovalRequest): Promise<ApprovalResponse>;
  getApproval(approvalId: string): Promise<ApprovalResponse>;
  consumeApproval(approvalId: string): Promise<ApprovalResponse>;
  sendAudit(events: ToolAuditEvent[]): Promise<void>;
  storeSessionArtifact(sessionId: string, body: SessionArtifactRequest): Promise<SessionArtifactResponse>;
}

export class ControllerClient implements ControllerApi {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  private async request(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<{ status: number; json: unknown }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ControllerError(`Runtime Controller に接続できません: ${(err as Error).message}`);
    }
    const text = await res.text().catch(() => "");
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  }

  private fail(status: number, json: unknown, what: string): never {
    const err = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ControllerError(err?.message ?? `${what}に失敗しました（HTTP ${status}）`, status, err?.code);
  }

  async getGrantByTokenHash(tokenHash: string): Promise<SessionGrant | null> {
    const { status, json } = await this.request("GET", `/internal/sessions/by-token-hash/${tokenHash}`);
    if (status === 404) return null;
    if (status !== 200) this.fail(status, json, "セッションの確認");
    const parsed = sessionGrantSchema.safeParse(json);
    if (!parsed.success) throw new ControllerError("セッション情報の形式が正しくありません");
    return parsed.data;
  }

  async getGrantBySessionId(sessionId: string): Promise<SessionGrant | null> {
    const { status, json } = await this.request("GET", `/internal/sessions/${encodeURIComponent(sessionId)}/grant`);
    if (status === 404) return null;
    if (status !== 200) this.fail(status, json, "セッションの確認");
    const parsed = sessionGrantSchema.safeParse(json);
    if (!parsed.success) throw new ControllerError("セッション情報の形式が正しくありません");
    return parsed.data;
  }

  private async approval(method: "GET" | "POST", path: string, body?: unknown): Promise<ApprovalResponse> {
    const { status, json } = await this.request(method, path, body);
    if (status !== 200) this.fail(status, json, "承認の処理");
    const parsed = approvalResponseSchema.safeParse(json);
    if (!parsed.success) throw new ControllerError("承認の応答の形式が正しくありません");
    return parsed.data;
  }

  createApproval(req: ApprovalRequest): Promise<ApprovalResponse> {
    return this.approval("POST", "/internal/approvals", req);
  }

  getApproval(approvalId: string): Promise<ApprovalResponse> {
    return this.approval("GET", `/internal/approvals/${encodeURIComponent(approvalId)}`);
  }

  consumeApproval(approvalId: string): Promise<ApprovalResponse> {
    return this.approval("POST", `/internal/approvals/${encodeURIComponent(approvalId)}/consume`);
  }

  async sendAudit(events: ToolAuditEvent[]): Promise<void> {
    const { status, json } = await this.request("POST", "/internal/audit", { events });
    if (status < 200 || status >= 300) this.fail(status, json, "監査イベントの送信");
  }

  async storeSessionArtifact(sessionId: string, body: SessionArtifactRequest): Promise<SessionArtifactResponse> {
    const { status, json } = await this.request("POST", `/internal/sessions/${encodeURIComponent(sessionId)}/artifacts`, body, 150_000);
    if (status !== 200) this.fail(status, json, "成果物の保存");
    const parsed = sessionArtifactResponseSchema.safeParse(json);
    if (!parsed.success) throw new ControllerError("成果物の保存結果の形式が正しくありません");
    return parsed.data;
  }
}
