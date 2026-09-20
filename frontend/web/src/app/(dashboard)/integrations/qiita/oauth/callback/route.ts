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

export async function GET(request: NextRequest) {
  const store = cookies();
  const raw = store.get(CONNECTOR_OAUTH_COOKIE)?.value;
  deleteCookie(store, CONNECTOR_OAUTH_COOKIE);
  const saved = raw ? ((await unseal(raw, getSessionSecret())) as Record<string, unknown> | null) : null;
  const state = request.nextUrl.searchParams.get("state");
  const code = request.nextUrl.searchParams.get("code");
  const connectorId = typeof saved?.connector_id === "string" ? saved.connector_id : "";
  const agentId = typeof saved?.agent_id === "string" ? saved.agent_id : "";
  const savedState = typeof saved?.state === "string" ? saved.state : "";
  if (!code || !state || !isUuid(connectorId) || !isUuid(agentId) || !savedState || !timingSafeEqual(state, savedState)) {
    return redirectTo(isUuid(agentId) ? `/agents/${agentId}?connection_error=qiita_oauth_state` : "/agents");
  }

  try {
    const connection = await new ConnectorRepository().exchangeQiitaOAuth(connectorId, code);
    const agents = new AgentRepository();
    const project = await agents.getProject(agentId);
    const capabilities = [
      ...new Set(
        project.agent.capability_resolution.requirements
          .filter((requirement) => requirement.connector_id === connectorId)
          .flatMap((requirement) => requirement.tool_names),
      ),
    ];
    await agents.linkConnection(agentId, {
      stage: "staging",
      connector_id: connectorId,
      connection_id: connection.id,
      allowed_capabilities: capabilities,
    });
    return redirectTo(`/agents/${agentId}?tab=preview&connection=qiita`);
  } catch (error) {
    console.error("[qiita-oauth] Connectionを作成できませんでした", error instanceof Error ? error.message : error);
    return redirectTo(`/agents/${agentId}?connection_error=qiita_oauth_failed`);
  }
}
