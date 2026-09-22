import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { CONNECTOR_OAUTH_COOKIE } from "@/lib/auth/constants";
import { getSessionSecret } from "@/lib/auth/config";
import { timingSafeEqual } from "@/lib/auth/pkce";
import { redirectTo } from "@/lib/auth/responses";
import { deleteCookie } from "@/lib/auth/session";
import { unseal } from "@/lib/auth/session-crypto";
import { AgentRepository, ConnectorRepository } from "@/lib/repositories";
import { isUuid } from "@/lib/utils/organization";

export const dynamic = "force-dynamic";

/** OAuth の戻り。認可コードは API で token に交換し、この画面には token を一切出さない。 */
export async function GET(request: NextRequest) {
  const store = cookies();
  const raw = store.get(CONNECTOR_OAUTH_COOKIE)?.value;
  deleteCookie(store, CONNECTOR_OAUTH_COOKIE);
  const saved = raw ? ((await unseal(raw, getSessionSecret())) as Record<string, unknown> | null) : null;
  const state = request.nextUrl.searchParams.get("state");
  const code = request.nextUrl.searchParams.get("code");
  const str = (key: string) => (typeof saved?.[key] === "string" ? (saved[key] as string) : "");
  const connectorId = str("connector_id");
  const agentId = str("agent_id");
  const savedState = str("state");
  const returnTo = isUuid(agentId) ? `/agents/${agentId}?tab=build` : "/integrations";
  if (!code || !state || !isUuid(connectorId) || !savedState || !timingSafeEqual(state, savedState)) {
    return redirectTo(`${returnTo}${returnTo.includes("?") ? "&" : "?"}connection_error=oauth_state`);
  }

  try {
    const connection = await new ConnectorRepository().exchangeOAuth(connectorId, {
      code,
      redirect_uri: str("redirect_uri") || `${request.nextUrl.origin}/integrations/oauth/callback`,
      code_verifier: str("verifier") || undefined,
    });
    // 手動作成した Agent（Builder Job なし）から来た場合は、この Agent へ直接割り当てる
    if (isUuid(agentId) && !str("project_id")) {
      const agents = new AgentRepository();
      const project = await agents.getProject(agentId);
      const capabilities = [...new Set(project.agent.capability_resolution.requirements
        .filter((requirement) => requirement.connector_id === connectorId)
        .flatMap((requirement) => requirement.tool_names))];
      if (capabilities.length) {
        await agents.linkConnection(agentId, { stage: "staging", connector_id: connectorId, connection_id: connection.id, allowed_capabilities: capabilities });
      }
    }
    return redirectTo(`${returnTo}${returnTo.includes("?") ? "&" : "?"}connection=connected`);
  } catch (error) {
    console.error("[connector-oauth] Connectionを作成できませんでした", error instanceof Error ? error.message : error);
    return redirectTo(`${returnTo}${returnTo.includes("?") ? "&" : "?"}connection_error=oauth_failed`);
  }
}
