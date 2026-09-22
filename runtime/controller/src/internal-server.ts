import { approvalRequestSchema, auditBatchRequestSchema, SESSION_ARTIFACT_MAX_BYTES, sessionArtifactRequestSchema } from "@agent-studio/contracts";
import { serve, type ServerType } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AuditBuffer } from "./audit-buffer.js";
import type { GrantStore } from "./grants.js";
import type { Logger } from "./logger.js";
import { errorInfo } from "./logger.js";
import { RuntimeRevokedError, StudioApiError, type StudioApi } from "./studio-client.js";

export interface InternalApiDeps {
  grants: GrantStore;
  studio: Pick<StudioApi, "createApproval" | "getApproval" | "consumeApproval" | "storeSessionArtifact">;
  audit: Pick<AuditBuffer, "push">;
  /** Agent Studio の activeSessions で許可情報を取り直す */
  refreshActiveSessions: () => Promise<void>;
  health: () => Record<string, unknown>;
  logger: Logger;
  now?: () => number;
  /** 未知のトークンで activeSessions を取り直す最短間隔 */
  refreshIntervalMs?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;

const errorBody = (code: string, message: string) => ({ error: { code, message } });

/**
 * Tool Gateway 専用の内部 API（127.0.0.1 にだけ bind する）。
 * Session Worker は別タスクなので、ここには届かない。
 */
export function createInternalApp(deps: InternalApiDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? (() => Date.now());
  const refreshIntervalMs = deps.refreshIntervalMs ?? 10_000;
  let lastRefreshAt = Number.NEGATIVE_INFINITY;
  let refreshing: Promise<void> | undefined;

  const refreshAtMostOnce = async (): Promise<void> => {
    if (refreshing) return refreshing;
    if (now() - lastRefreshAt < refreshIntervalMs) return;
    lastRefreshAt = now();
    refreshing = deps
      .refreshActiveSessions()
      .catch((err) => deps.logger.warn({ err: errorInfo(err) }, "activeSessions を取得できませんでした"))
      .finally(() => {
        refreshing = undefined;
      });
    return refreshing;
  };

  const proxyError = (c: Context, err: unknown) => {
    if (err instanceof StudioApiError) {
      const status = (err.status >= 400 && err.status <= 599 ? err.status : 502) as ContentfulStatusCode;
      return c.json(errorBody(err.code ?? "upstream_error", err.message), status);
    }
    if (err instanceof RuntimeRevokedError) return c.json(errorBody("runtime_revoked", err.message), 403);
    deps.logger.warn({ err: errorInfo(err) }, "Agent Studio への中継に失敗しました");
    return c.json(errorBody("upstream_unavailable", "Agent Studio に接続できませんでした"), 502);
  };

  const readJson = async (c: Context): Promise<unknown> => {
    try {
      return await c.req.json();
    } catch {
      return undefined;
    }
  };

  app.get("/internal/health", (c) => c.json({ status: "ok", ...deps.health() }));

  app.get("/internal/sessions/by-token-hash/:hash", async (c) => {
    const hash = c.req.param("hash").toLowerCase();
    if (!HASH_RE.test(hash)) return c.json(errorBody("invalid_hash", "token_hash の形式が正しくありません"), 400);
    let grant = deps.grants.lookupByTokenHash(hash);
    if (!grant && !deps.grants.suspended) {
      await refreshAtMostOnce();
      grant = deps.grants.lookupByTokenHash(hash);
    }
    return grant ? c.json(grant) : c.json(errorBody("not_found", "セッションが見つかりません"), 404);
  });

  app.post("/internal/approvals", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const parsed = approvalRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json(errorBody("validation_error", "承認依頼の形式が正しくありません"), 400);
    try {
      return c.json(await deps.studio.createApproval(parsed.data));
    } catch (err) {
      return proxyError(c, err);
    }
  });

  app.get("/internal/approvals/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json(errorBody("validation_error", "承認 ID の形式が正しくありません"), 400);
    try {
      return c.json(await deps.studio.getApproval(id));
    } catch (err) {
      return proxyError(c, err);
    }
  });

  app.post("/internal/approvals/:id/consume", async (c) => {
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json(errorBody("validation_error", "承認 ID の形式が正しくありません"), 400);
    try {
      return c.json(await deps.studio.consumeApproval(id));
    } catch (err) {
      return proxyError(c, err);
    }
  });

  app.post("/internal/sessions/:id/artifacts", bodyLimit({ maxSize: Math.ceil(SESSION_ARTIFACT_MAX_BYTES / 3) * 4 + 64 * 1024 }), async (c) => {
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json(errorBody("validation_error", "セッション ID の形式が正しくありません"), 400);
    const parsed = sessionArtifactRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json(errorBody("validation_error", "成果物の形式が正しくありません"), 400);
    try {
      return c.json(await deps.studio.storeSessionArtifact(id, parsed.data));
    } catch (err) {
      return proxyError(c, err);
    }
  });

  app.post("/internal/audit", bodyLimit({ maxSize: 2 * 1024 * 1024 }), async (c) => {
    const parsed = auditBatchRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json(errorBody("validation_error", "監査イベントの形式が正しくありません"), 400);
    deps.audit.push(parsed.data.events);
    return c.json({ accepted: parsed.data.events.length }, 202);
  });

  app.notFound((c) => c.json(errorBody("not_found", "見つかりません"), 404));
  app.onError((err, c) => {
    deps.logger.error({ err: errorInfo(err) }, "内部 API でエラーが発生しました");
    return c.json(errorBody("internal_error", "内部エラーが発生しました"), 500);
  });
  return app;
}

export function startInternalServer(app: Hono, port: number): ServerType {
  return serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
}
