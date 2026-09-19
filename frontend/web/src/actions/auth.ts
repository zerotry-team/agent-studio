"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { runAction } from "@/lib/api/run-action";
import { getAuthMode } from "@/lib/auth/config";
import { sanitizeReturnTo } from "@/lib/auth/pkce";
import { createDevSession, writeSession } from "@/lib/auth/session";
import { SwitchOrganizationService } from "@/lib/services/me";

export interface DevLoginState {
  error?: string;
}

/** 開発用ログイン（AUTH_MODE=dev のときだけ。本番では使えない） */
export async function devLoginAction(_prev: DevLoginState, formData: FormData): Promise<DevLoginState> {
  let mode: string;
  try {
    mode = getAuthMode();
  } catch {
    return { error: "本番環境では開発用ログインは使えません" };
  }
  if (mode !== "dev") return { error: "開発用ログインは無効です" };

  const email = z.email().safeParse(String(formData.get("email") ?? "").trim());
  if (!email.success) return { error: "メールアドレスの形式が正しくありません" };

  try {
    await writeSession(createDevSession(email.data.toLowerCase()));
  } catch (e) {
    console.error("[auth] dev login failed", e);
    return { error: "ログインできませんでした。もう一度お試しください" };
  }
  redirect(sanitizeReturnTo(String(formData.get("next") ?? "/")));
}

/** 操作中の組織を切り替える */
export async function switchOrganizationAction(organizationId: string) {
  return runAction(() => new SwitchOrganizationService().invoke(organizationId), "組織を切り替えられませんでした");
}
