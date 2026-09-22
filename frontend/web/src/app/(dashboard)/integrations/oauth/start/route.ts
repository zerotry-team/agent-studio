import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { CONNECTOR_OAUTH_COOKIE, OAUTH_STATE_MAX_AGE_SECONDS } from "@/lib/auth/constants";
import { getSessionSecret } from "@/lib/auth/config";
import { createCodeChallenge, createCodeVerifier, createState } from "@/lib/auth/pkce";
import { redirectTo, redirectToExternal } from "@/lib/auth/responses";
import { cookieOptions } from "@/lib/auth/session";
import { seal } from "@/lib/auth/session-crypto";
import { BuilderProjectRepository, ConnectorRepository } from "@/lib/repositories";
import { isUuid } from "@/lib/utils/organization";

export const dynamic = "force-dynamic";

/**
 * 連携サービスの OAuth 同意を開始する（Provider を問わず共通）。
 * `connector` と、戻り先の `agent` または Builder の `project` を受け取る。
 * state と PKCE verifier は封印 cookie に保存し、URL や API には平文で残さない。
 */
export async function GET(request: NextRequest) {
  const connectorId = request.nextUrl.searchParams.get("connector") ?? "";
  const projectId = request.nextUrl.searchParams.get("project") ?? "";
  let agentId = request.nextUrl.searchParams.get("agent") ?? "";
  if (!isUuid(connectorId)) return redirectTo("/integrations");
  if (!isUuid(agentId) && isUuid(projectId)) {
    try {
      agentId = (await new BuilderProjectRepository().get(projectId)).agent_id ?? "";
    } catch {
      return redirectTo("/agents");
    }
  }
  // 連携サービス画面から始めた場合は同じ画面へ戻す
  const returnTo = isUuid(agentId) ? `/agents/${agentId}?tab=build` : "/integrations?";

  const connectors = new ConnectorRepository();
  const oauthApp = await connectors.getOAuthApp(connectorId).catch(() => null);
  if (!oauthApp?.configured) return redirectTo(`${returnTo}&connection_error=oauth_not_configured`.replace("?&", "?"));

  const state = createState();
  const verifier = createCodeVerifier();
  const redirectUri = `${request.nextUrl.origin}/integrations/oauth/callback`;
  let authorizeUrl: string;
  try {
    authorizeUrl = (await connectors.startOAuth(connectorId, { redirect_uri: redirectUri, state, code_challenge: await createCodeChallenge(verifier) })).authorize_url;
  } catch (error) {
    console.error("[connector-oauth] 認可URLを作成できませんでした", error instanceof Error ? error.message : error);
    return redirectTo(`${returnTo}&connection_error=oauth_failed`.replace("?&", "?"));
  }
  const saved = await seal(
    { state, verifier, connector_id: connectorId, agent_id: agentId, project_id: isUuid(projectId) ? projectId : "", redirect_uri: redirectUri },
    getSessionSecret(),
    OAUTH_STATE_MAX_AGE_SECONDS,
  );
  cookies().set(CONNECTOR_OAUTH_COOKIE, saved, cookieOptions(OAUTH_STATE_MAX_AGE_SECONDS));
  return redirectToExternal(authorizeUrl);
}
