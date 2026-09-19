import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { exchangeAuthorizationCode, sessionFromTokenResponse } from "@/lib/auth/cognito";
import { getAuthMode, getCognitoSettings } from "@/lib/auth/config";
import { OAUTH_COOKIE } from "@/lib/auth/constants";
import { sanitizeReturnTo, timingSafeEqual } from "@/lib/auth/pkce";
import { authErrorPath, redirectTo } from "@/lib/auth/responses";
import { deleteCookie, readOAuthState, writeSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/** Cognito からの戻り先。state を確認し、認可コードをトークンに交換してセッションを作る */
export async function GET(request: NextRequest) {
  let mode: ReturnType<typeof getAuthMode>;
  try {
    mode = getAuthMode();
  } catch {
    return redirectTo(authErrorPath("config"));
  }
  if (mode !== "cognito") return redirectTo("/auth/login");

  const params = request.nextUrl.searchParams;
  const store = cookies();
  const saved = await readOAuthState(store);
  deleteCookie(store, OAUTH_COOKIE);

  if (params.get("error")) {
    console.warn("[auth] Cognito がエラーを返しました", params.get("error"));
    return redirectTo(authErrorPath("denied"));
  }

  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state || !saved || !timingSafeEqual(state, saved.state)) {
    return redirectTo(authErrorPath("state"));
  }

  try {
    const settings = getCognitoSettings();
    const tokens = await exchangeAuthorizationCode(settings, { code, codeVerifier: saved.code_verifier });
    await writeSession(sessionFromTokenResponse(tokens), store);
  } catch (e) {
    console.error("[auth] 認可コードをトークンに交換できませんでした", e instanceof Error ? e.message : e);
    return redirectTo(authErrorPath("token"));
  }

  return redirectTo(sanitizeReturnTo(saved.return_to));
}
