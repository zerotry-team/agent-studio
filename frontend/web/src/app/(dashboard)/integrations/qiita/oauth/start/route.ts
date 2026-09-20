import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { CONNECTOR_OAUTH_COOKIE, OAUTH_STATE_MAX_AGE_SECONDS } from "@/lib/auth/constants";
import { getSessionSecret } from "@/lib/auth/config";
import { redirectTo, redirectToExternal } from "@/lib/auth/responses";
import { cookieOptions } from "@/lib/auth/session";
import { seal } from "@/lib/auth/session-crypto";
import { isUuid } from "@/lib/utils/organization";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const connectorId = request.nextUrl.searchParams.get("connector") ?? "";
  const agentId = request.nextUrl.searchParams.get("agent") ?? "";
  if (!isUuid(connectorId) || !isUuid(agentId)) return redirectTo("/agents");
  const clientId = process.env.QIITA_OAUTH_CLIENT_ID?.trim();
  if (!clientId || clientId === "unset") return redirectTo(`/agents/${agentId}?connection_error=qiita_oauth_not_configured`);

  const state = randomBytes(32).toString("hex");
  const saved = await seal({ state, connector_id: connectorId, agent_id: agentId }, getSessionSecret(), OAUTH_STATE_MAX_AGE_SECONDS);
  cookies().set(CONNECTOR_OAUTH_COOKIE, saved, cookieOptions(OAUTH_STATE_MAX_AGE_SECONDS));
  const url = new URL("https://qiita.com/api/v2/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", "read_qiita write_qiita");
  url.searchParams.set("state", state);
  return redirectToExternal(url.toString());
}
