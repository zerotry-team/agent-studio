import { cookies } from "next/headers";
import { buildLogoutUrl } from "@/lib/auth/cognito";
import { getAuthMode, getCognitoSettings } from "@/lib/auth/config";
import { ORG_COOKIE } from "@/lib/auth/constants";
import { redirectTo, redirectToExternal } from "@/lib/auth/responses";
import { clearAuthCookies, deleteCookie } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/** Cookie を消して、Cognito のログアウト（→ APP_BASE_URL/）へリダイレクトする */
function logout(): Response {
  const store = cookies();
  clearAuthCookies(store);
  deleteCookie(store, ORG_COOKIE);

  try {
    if (getAuthMode() === "cognito") {
      return redirectToExternal(buildLogoutUrl(getCognitoSettings()), 303);
    }
    return redirectTo("/auth/dev-login");
  } catch (e) {
    console.error("[auth]", e instanceof Error ? e.message : e);
    return redirectTo("/auth/login");
  }
}

export function GET() {
  return logout();
}

export function POST() {
  return logout();
}
