import "server-only";
import type { AuditLogDto } from "@agent-studio/contracts";
import { ApiRepository, type ListQuery } from "./base";

export class AuditLogRepository extends ApiRepository {
  list(query: ListQuery = {}): Promise<AuditLogDto[]> {
    return this.api.get<AuditLogDto[]>("/audit-logs", { ...query });
  }
}
