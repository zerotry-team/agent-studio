import "server-only";
import { listQuerySchema, type AuditLogDto } from "@agent-studio/contracts";
import { AuditLogRepository, type ListQuery } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

export class ListAuditLogsService {
  constructor(private readonly auditLogs = new AuditLogRepository()) {}

  invoke(query: ListQuery = {}): Promise<AuditLogDto[]> {
    const parsed = parseInput(listQuerySchema, query);
    return this.auditLogs.list({ limit: parsed.limit, before: parsed.before });
  }
}
