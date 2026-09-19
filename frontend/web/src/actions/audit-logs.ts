"use server";

import { runAction } from "@/lib/api/run-action";
import type { ListQuery } from "@/lib/repositories";
import { ListAuditLogsService } from "@/lib/services/audit-logs";

export async function listAuditLogsAction(query: ListQuery = {}) {
  return runAction(() => new ListAuditLogsService().invoke(query), "監査ログを取得できませんでした");
}
