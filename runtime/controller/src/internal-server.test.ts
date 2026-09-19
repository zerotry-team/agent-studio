import type { SessionGrant, ToolAuditEvent } from "@agent-studio/contracts";
import { describe, expect, it, vi } from "vitest";
import { GrantStore } from "./grants.js";
import { createInternalApp } from "./internal-server.js";
import { createLogger } from "./logger.js";
import { StudioApiError } from "./studio-client.js";

const logger = createLogger("silent");
const grant: SessionGrant = {
  session_id: "00000000-0000-4000-8000-000000000001",
  run_id: "10000000-0000-4000-8000-000000000001",
  token_hash: "a".repeat(64),
  allowed_tools: ["get_product"],
  policies: [],
  expires_at: "2099-01-01T00:00:00.000Z",
};
const APPROVAL_ID = "50000000-0000-4000-8000-000000000001";

function setup() {
  const grants = new GrantStore();
  let now = 0;
  const refreshActiveSessions = vi.fn(async () => {
    grants.syncFromActive([grant], 120);
  });
  const studio = {
    createApproval: vi.fn(async () => ({ approval_id: APPROVAL_ID, status: "pending" as const })),
    getApproval: vi.fn(async (): Promise<never> => {
      throw new StudioApiError(404, "not_found", "承認が見つかりません");
    }),
    consumeApproval: vi.fn(async () => ({ approval_id: APPROVAL_ID, status: "consumed" as const })),
  };
  const pushed: ToolAuditEvent[] = [];
  const app = createInternalApp({
    grants,
    studio,
    audit: { push: (events) => pushed.push(...events) },
    refreshActiveSessions,
    health: () => ({}),
    logger,
    now: () => now,
  });
  return { app, grants, refreshActiveSessions, studio, pushed, setNow: (t: number) => (now = t) };
}

describe("内部 API", () => {
  it("未知の token_hash なら activeSessions を取り直してから探す（10 秒に 1 回まで）", async () => {
    const { app, refreshActiveSessions, setNow } = setup();
    const unknown = await app.request(`/internal/sessions/by-token-hash/${"b".repeat(64)}`);
    expect(unknown.status).toBe(404);
    expect(refreshActiveSessions).toHaveBeenCalledTimes(1);

    setNow(5_000);
    const res = await app.request(`/internal/sessions/by-token-hash/${"a".repeat(64)}`);
    // 取り直し済みなので、手元の情報だけで見つかる
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(grant);

    await app.request(`/internal/sessions/by-token-hash/${"c".repeat(64)}`);
    expect(refreshActiveSessions).toHaveBeenCalledTimes(1);
    setNow(11_000);
    await app.request(`/internal/sessions/by-token-hash/${"c".repeat(64)}`);
    expect(refreshActiveSessions).toHaveBeenCalledTimes(2);
  });

  it("token_hash の形式が違えば 400", async () => {
    const { app } = setup();
    expect((await app.request("/internal/sessions/by-token-hash/xyz")).status).toBe(400);
  });

  it("承認依頼を Agent Studio に中継し、エラーのステータスもそのまま返す", async () => {
    const { app, studio } = setup();
    const body = {
      session_id: grant.session_id,
      tool: "update_price",
      args_hash: "d".repeat(64),
      args_preview: '{"price_change":-600}',
      reason: "値下げには承認が必要です",
      timeout_minutes: 60,
    };
    const created = await app.request("/internal/approvals", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ approval_id: APPROVAL_ID, status: "pending" });
    expect(studio.createApproval).toHaveBeenCalledWith(body);

    const missing = await app.request(`/internal/approvals/${APPROVAL_ID}`);
    expect(missing.status).toBe(404);

    const consumed = await app.request(`/internal/approvals/${APPROVAL_ID}/consume`, { method: "POST" });
    expect(await consumed.json()).toEqual({ approval_id: APPROVAL_ID, status: "consumed" });

    expect((await app.request("/internal/approvals/not-a-uuid")).status).toBe(400);
  });

  it("監査イベントを検証してバッファに積む", async () => {
    const { app, pushed } = setup();
    const event: ToolAuditEvent = {
      session_id: grant.session_id,
      tool: "get_product",
      args_hash: "e".repeat(64),
      decision: "executed",
      duration_ms: 12,
      at: "2026-09-19T06:00:00.000Z",
    };
    const ok = await app.request("/internal/audit", { method: "POST", body: JSON.stringify({ events: [event] }) });
    expect(ok.status).toBe(202);
    expect(pushed).toEqual([event]);

    const bad = await app.request("/internal/audit", { method: "POST", body: JSON.stringify({ events: [{ tool: "x" }] }) });
    expect(bad.status).toBe(400);
  });
});
