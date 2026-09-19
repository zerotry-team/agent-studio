import type { NextRequest } from "next/server";
import { callbackUrl } from "@/lib/auth/cognito";
import { getAuthMode, getCognitoSettings } from "@/lib/auth/config";
import { buildAuthorizeUrl, createCodeChallenge, createCodeVerifier, createState, sanitizeReturnTo } from "@/lib/auth/pkce";
import { authErrorPath, redirectTo, redirectToExternal } from "@/lib/auth/responses";
import { writeOAuthState } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * ログインの開始。
 * - cognito: state と code_verifier を短時間の Cookie に保存し、Cognito の Hosted UI へリダイレクトする（PKCE, S256）
 * - dev: 開発用のメールアドレス入力画面へ
 */
export async function GET(request: NextRequest) {
  const next = sanitizeReturnTo(request.nextUrl.searchParams.get("next"));

  let mode: ReturnType<typeof getAuthMode>;
  try {
    mode = getAuthMode();
  } catch (e) {
    console.error("[auth]", e instanceof Error ? e.message : e);
    return redirectTo(authErrorPath("config"));
  }

  if (mode === "dev") {
    return redirectTo(next === "/" ? "/auth/dev-login" : `/auth/dev-login?next=${encodeURIComponent(next)}`);
  }

  try {
    const settings = getCognitoSettings();
    const codeVerifier = createCodeVerifier();
    const codeChallenge = await createCodeChallenge(codeVerifier);
    const state = createState();
    await writeOAuthState({ state, code_verifier: codeVerifier, return_to: next });
    const url = buildAuthorizeUrl({
      domain: settings.domain,
      clientId: settings.clientId,
      redirectUri: callbackUrl(settings),
      state,
      codeChallenge,
      scope: "openid email profile",
    });
    return redirectToExternal(url);
  } catch (e) {
    console.error("[auth] ログインを開始できませんでした", e instanceof Error ? e.message : e);
    return redirectTo(authErrorPath("config"));
  }
}
