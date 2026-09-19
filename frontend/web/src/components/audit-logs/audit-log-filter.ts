import type { AuditLogDto } from "@agent-studio/contracts";

export type ActorTypeFilter = "all" | AuditLogDto["actor_type"];
export type ResultFilter = "all" | AuditLogDto["result"];

export interface AuditLogFilters {
  /** 操作・対象・実行者に含まれる文字 */
  query: string;
  actorType: ActorTypeFilter;
  result: ResultFilter;
}

export const EMPTY_AUDIT_LOG_FILTERS: AuditLogFilters = { query: "", actorType: "all", result: "all" };

export function hasActiveFilters(filters: AuditLogFilters): boolean {
  return filters.query.trim() !== "" || filters.actorType !== "all" || filters.result !== "all";
}

/** 読み込み済みの記録を絞り込む（API は limit / before しか受け付けないため、画面側で行う） */
export function filterAuditLogs(items: readonly AuditLogDto[], filters: AuditLogFilters): AuditLogDto[] {
  const q = filters.query.trim().toLowerCase();
  return items.filter((item) => {
    if (filters.actorType !== "all" && item.actor_type !== filters.actorType) return false;
    if (filters.result !== "all" && item.result !== filters.result) return false;
    if (!q) return true;
    return [item.action, item.target_type, item.target_id, item.actor_label, item.actor_id, item.source_ip].some(
      (v) => typeof v === "string" && v.toLowerCase().includes(q),
    );
  });
}
