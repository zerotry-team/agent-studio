"use server";

import { runAction } from "@/lib/api/run-action";
import { GetUsageService } from "@/lib/services/usage";

/** month: YYYY-MM（省略時は今月） */
export async function getUsageAction(month?: string) {
  return runAction(() => new GetUsageService().invoke(month), "利用状況を取得できませんでした");
}
