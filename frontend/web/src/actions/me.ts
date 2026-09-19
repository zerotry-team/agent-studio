"use server";

import { runAction } from "@/lib/api/run-action";
import { GetCurrentUserService } from "@/lib/services/me";

export async function getCurrentUserAction() {
  return runAction(() => new GetCurrentUserService().invoke(), "ログイン中のユーザー情報を取得できませんでした");
}
