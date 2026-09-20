import {
  canonicalJson,
  evaluatePolicies,
  toolCallHash,
  type ApprovalResponse,
  type PolicyDecision,
  type RuntimeHttpTool,
  type SessionGrant,
} from "@agent-studio/contracts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AuditSink } from "./audit.js";
import type { CatalogTool, ToolCatalog } from "./catalog.js";
import type { ControllerApi } from "./controller-client.js";
import { textResult, ToolInputError, type HttpToolOutcome } from "./http-tool.js";
import type { Logger } from "./logger.js";
import { errorMessage } from "./logger.js";
import { MESSAGES } from "./messages.js";
import { SecretUnavailableError } from "./secrets.js";
import type { UpstreamSessionPool } from "./upstream.js";

export interface ToolCallServiceDeps {
  catalog: Pick<ToolCatalog, "get" | "globalPolicies">;
  controller: Pick<ControllerApi, "createApproval" | "getApproval" | "consumeApproval">;
  audit: AuditSink;
  executeHttp: (tool: RuntimeHttpTool, args: Record<string, unknown>) => Promise<HttpToolOutcome>;
  upstream: Pick<UpstreamSessionPool, "callTool">;
  /** 承認を待つ最大時間（この間に承認されれば、そのまま実行する） */
  approvalWaitMs: number;
  approvalPollIntervalMs: number;
  logger: Logger;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const ARGS_PREVIEW_MAX = 4000;

type ApprovalOutcome = { kind: "approved"; approvalId: string } | { kind: "blocked"; result: CallToolResult };

/**
 * tools/call の本体: 許可判定 → ポリシー → 承認 → 実行 → 監査（SEC-13）。
 * モデルの判断に頼らず、ここで必ず強制する。
 */
export class ToolCallService {
  /** セッション × ツールの実行回数（rate_limit 用） */
  private readonly counters = new Map<string, { count: number; expiresAt: number }>();
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: ToolCallServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private counterKey(sessionId: string, tool: string): string {
    return `${sessionId}\u0000${tool}`;
  }

  callsSoFar(sessionId: string, tool: string): number {
    return this.counters.get(this.counterKey(sessionId, tool))?.count ?? 0;
  }

  private countCall(grant: SessionGrant, tool: string): void {
    const key = this.counterKey(grant.session_id, tool);
    const entry = this.counters.get(key) ?? { count: 0, expiresAt: Date.parse(grant.expires_at) };
    entry.count++;
    entry.expiresAt = Date.parse(grant.expires_at);
    this.counters.set(key, entry);
  }

  /** 期限の切れたセッションのカウンタを消す */
  sweepCounters(): void {
    const now = this.now().getTime();
    for (const [key, entry] of this.counters) if (entry.expiresAt <= now) this.counters.delete(key);
  }

  async call(grant: SessionGrant, name: string, rawArgs: unknown): Promise<CallToolResult> {
    const { audit, catalog } = this.deps;
    const sessionId = grant.session_id;
    const args = rawArgs === undefined || rawArgs === null ? {} : rawArgs;
    const argsHash = await toolCallHash(name, args);
    const record = (decision: "denied" | "approval_required" | "executed" | "failed", detail?: string, durationMs?: number) =>
      audit.record({
        session_id: sessionId,
        tool: name.slice(0, 128),
        args_hash: argsHash,
        decision,
        ...(detail ? { detail } : {}),
        ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
      });

    if (typeof args !== "object" || Array.isArray(args)) {
      record("denied", "引数がオブジェクトではありません");
      return textResult(MESSAGES.invalidArguments, true);
    }
    const argsObject = args as Record<string, unknown>;

    const tool = grant.allowed_tools.includes(name) ? catalog.get(name) : undefined;
    if (!tool) {
      record("denied", "このセッションで許可されていないツール");
      return textResult(MESSAGES.toolNotAllowed(name), true);
    }

    // 組織・Agent（grant）→ ツール・配下のサーバー → Runtime 全体。最も厳しい結果になる
    const decision = evaluatePolicies([...grant.policies, ...tool.policies, ...catalog.globalPolicies], {
      tool: name,
      args: argsObject,
      now: this.now(),
      callsSoFar: this.callsSoFar(sessionId, name),
    });

    if (decision.action === "deny") {
      record("denied", decision.reason);
      return textResult(decision.reason, true);
    }

    let approvalId: string | undefined;
    if (decision.action === "require_approval") {
      const outcome = await this.awaitApproval(grant, name, argsObject, argsHash, decision, record);
      if (outcome.kind === "blocked") return outcome.result;
      approvalId = outcome.approvalId;
    }
    return this.execute(grant, tool, argsObject, approvalId, record);
  }

  private async awaitApproval(
    grant: SessionGrant,
    name: string,
    args: Record<string, unknown>,
    argsHash: string,
    decision: Extract<PolicyDecision, { action: "require_approval" }>,
    record: (decision: "denied" | "approval_required" | "failed", detail?: string) => void,
  ): Promise<ApprovalOutcome> {
    const { controller, logger } = this.deps;
    const log = logger.child({ session_id: grant.session_id, tool: name, args_hash: argsHash });

    let approval: ApprovalResponse;
    try {
      // 同じセッション・同じ引数の承認が待ち中・承認済みなら、Agent Studio は既存のものを返す
      approval = await controller.createApproval({
        session_id: grant.session_id,
        tool: name,
        args_hash: argsHash,
        args_preview: canonicalJson(args).slice(0, ARGS_PREVIEW_MAX),
        reason: decision.reason.slice(0, 1000),
        timeout_minutes: decision.timeout_minutes,
      });
    } catch (err) {
      log.warn({ err: errorMessage(err) }, "承認依頼を送れませんでした");
      record("failed", "承認依頼を送れませんでした");
      return { kind: "blocked", result: textResult(MESSAGES.approvalUnavailable, true) };
    }

    const deadline = this.now().getTime() + this.deps.approvalWaitMs;
    while (approval.status === "pending") {
      const remaining = deadline - this.now().getTime();
      if (remaining <= 0) break;
      await this.sleep(Math.min(this.deps.approvalPollIntervalMs, remaining));
      try {
        approval = await controller.getApproval(approval.approval_id);
      } catch (err) {
        // 一時的な失敗は待ち時間の範囲で再試行する
        log.debug({ err: errorMessage(err) }, "承認の状態を取得できませんでした");
      }
    }

    const id = approval.approval_id;
    if (approval.status !== "approved") return this.blockedBy(approval.status, id, record);

    let consumed: ApprovalResponse;
    try {
      // 承認は 1 回だけ使える。先に消費してから実行する
      consumed = await controller.consumeApproval(id);
    } catch (err) {
      log.warn({ err: errorMessage(err), approval_id: id }, "承認を消費できませんでした");
      record("failed", `承認を消費できませんでした（承認ID: ${id}）`);
      return { kind: "blocked", result: textResult(MESSAGES.approvalUnavailable, true) };
    }
    // 消費できなかったとき（期限切れ・同時実行で先に使われた など）は、その時点の状態が返る
    if (consumed.status !== "consumed") return this.blockedBy(consumed.status, id, record);
    log.info({ approval_id: id }, "承認済みのため実行します");
    return { kind: "approved", approvalId: id };
  }

  private blockedBy(
    status: ApprovalResponse["status"],
    id: string,
    record: (decision: "denied" | "approval_required" | "failed", detail?: string) => void,
  ): ApprovalOutcome {
    switch (status) {
      case "pending":
        record("approval_required", `承認待ち（承認ID: ${id}）`);
        return { kind: "blocked", result: textResult(MESSAGES.approvalPending(id), true) };
      case "denied":
        record("denied", `承認者が却下しました（承認ID: ${id}）`);
        return { kind: "blocked", result: textResult(MESSAGES.approvalDenied, true) };
      case "expired":
        record("denied", `承認の期限切れ（承認ID: ${id}）`);
        return { kind: "blocked", result: textResult(MESSAGES.approvalExpired, true) };
      case "consumed":
        record("denied", `使用済みの承認（承認ID: ${id}）`);
        return { kind: "blocked", result: textResult(MESSAGES.approvalConsumed, true) };
      case "approved":
        record("failed", `承認を消費できませんでした（承認ID: ${id}）`);
        return { kind: "blocked", result: textResult(MESSAGES.approvalUnavailable, true) };
    }
  }

  private async execute(
    grant: SessionGrant,
    tool: CatalogTool,
    args: Record<string, unknown>,
    approvalId: string | undefined,
    record: (decision: "executed" | "failed", detail?: string, durationMs?: number) => void,
  ): Promise<CallToolResult> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const withApproval = (detail?: string) =>
      [approvalId ? `承認ID: ${approvalId}` : undefined, detail].filter(Boolean).join(" / ") || undefined;
    this.countCall(grant, tool.name);

    try {
      let result: CallToolResult;
      let detail: string | undefined;
      if (tool.target.kind === "http") {
        const outcome = await this.deps.executeHttp(tool.target.tool, args);
        result = outcome.result;
        detail = outcome.auditDetail;
      } else {
        const configured = tool.target.upstream;
        const upstream =
          configured.dynamic_session_endpoint === "browser"
            ? grant.browser
              ? { ...configured, url: grant.browser.endpoint }
              : null
            : configured;
        if (!upstream) throw new Error("Browser Session が起動していないか、すでに失われています");
        result = await this.deps.upstream.callTool(grant, upstream, tool.target.toolName, args);
      }
      record(result.isError ? "failed" : "executed", withApproval(detail), elapsed());
      return result;
    } catch (err) {
      const duration = elapsed();
      if (err instanceof ToolInputError) {
        record("failed", withApproval("引数の誤り"), duration);
        return textResult(err.message, true);
      }
      if (err instanceof SecretUnavailableError) {
        this.deps.logger.error({ tool: tool.name, secret: err.secretName }, "業務システムの認証情報を取得できません");
        record("failed", withApproval("認証情報を取得できません"), duration);
        return textResult(MESSAGES.credentialsUnavailable, true);
      }
      this.deps.logger.warn({ tool: tool.name, session_id: grant.session_id, err: errorMessage(err) }, "ツールの実行に失敗しました");
      // 例外の文言には URL（=引数）が含まれることがあるため、監査には種類だけを残す
      record("failed", withApproval(`実行エラー（${(err as Error).name ?? "Error"}）`), duration);
      return textResult(MESSAGES.executionFailed(errorMessage(err)), true);
    }
  }
}
