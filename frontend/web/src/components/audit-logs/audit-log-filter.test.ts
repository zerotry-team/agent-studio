import type { AuditLogDto } from "@agent-studio/contracts";
import { describe, expect, it } from "vitest";
import { EMPTY_AUDIT_LOG_FILTERS, filterAuditLogs, hasActiveFilters } from "./audit-log-filter";

function log(overrides: Partial<AuditLogDto>): AuditLogDto {
  return {
    id: "id",
    actor_type: "user",
    actor_id: "u-1",
    actor_label: "tanaka@example.com",
    action: "agent.create",
    target_type: "agent",
    target_id: "a-1",
    result: "success",
    detail: null,
    source_ip: "203.0.113.1",
    created_at: "2026-09-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("filterAuditLogs", () => {
  const items = [
    log({ id: "1" }),
    log({ id: "2", actor_type: "runtime", actor_label: "prod-runtime", action: "runtime.heartbeat", result: "failure" }),
    log({ id: "3", actor_type: "system", actor_label: null, action: "approval.expire", target_type: "approval", result: "denied" }),
  ];

  it("条件なしならすべて", () => {
    expect(filterAuditLogs(items, EMPTY_AUDIT_LOG_FILTERS)).toHaveLength(3);
    expect(hasActiveFilters(EMPTY_AUDIT_LOG_FILTERS)).toBe(false);
  });

  it("検索は操作・対象・実行者を大文字小文字を区別せずに探す", () => {
    expect(filterAuditLogs(items, { ...EMPTY_AUDIT_LOG_FILTERS, query: "RUNTIME" }).map((i) => i.id)).toEqual(["2"]);
    expect(filterAuditLogs(items, { ...EMPTY_AUDIT_LOG_FILTERS, query: "approval" }).map((i) => i.id)).toEqual(["3"]);
    expect(filterAuditLogs(items, { ...EMPTY_AUDIT_LOG_FILTERS, query: "tanaka" }).map((i) => i.id)).toEqual(["1"]);
  });

  it("実行者の種類と結果で絞り込む", () => {
    expect(filterAuditLogs(items, { ...EMPTY_AUDIT_LOG_FILTERS, actorType: "system" }).map((i) => i.id)).toEqual(["3"]);
    expect(filterAuditLogs(items, { ...EMPTY_AUDIT_LOG_FILTERS, result: "failure" }).map((i) => i.id)).toEqual(["2"]);
    expect(filterAuditLogs(items, { query: "", actorType: "user", result: "failure" })).toHaveLength(0);
  });
});
