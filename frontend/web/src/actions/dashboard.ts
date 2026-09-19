"use server";

import { runAction } from "@/lib/api/run-action";
import { GetDashboardSummaryService } from "@/lib/services/dashboard";

export async function getDashboardSummaryAction() {
  return runAction(() => new GetDashboardSummaryService().invoke(), "ダッシュボードの情報を取得できませんでした");
}
