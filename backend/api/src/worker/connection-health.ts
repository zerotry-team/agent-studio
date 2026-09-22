import type { ConnectionDto } from "@agent-studio/contracts";
import type { Prisma } from "@prisma/client";
import type { Deps } from "../application/deps.js";
import { assertPublicUrl } from "../infrastructure/http/public-url.js";

const HEALTH_CHECK_STALE_SECONDS = 15 * 60;
const HEALTH_CHECK_LIMIT = 20;

type FetchLike = typeof fetch;
type UrlValidator = (raw: string) => Promise<URL>;

/** Providerのread-only代表操作を定期実行し、ConnectionとProduction Healthへ反映する。 */
export class ConnectionHealthMonitor {
  constructor(
    private readonly deps: Deps,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly validateUrl: UrlValidator = assertPublicUrl,
  ) {}

  async tick(): Promise<void> {
    const items = await this.deps.system.claimConnectionHealthChecks(this.deps.env.WORKER_ID, HEALTH_CHECK_STALE_SECONDS, HEALTH_CHECK_LIMIT);
    for (const item of items) {
      try {
        await this.check(item.organization_id, item.connection_id);
      } catch (error) {
        this.deps.logger.warn({ err: error, connection_id: item.connection_id }, "Connectionの定期Health checkに失敗しました");
        await this.save(item.organization_id, item.connection_id, "error", { reason: "health_check_error" });
      }
    }
  }

  private async check(organizationId: string, connectionId: string): Promise<void> {
    const connection = await this.deps.db.org(organizationId, (tx) => tx.connections.findFirst({
      where: { id: connectionId, organization_id: organizationId, revoked_at: null },
      include: { connector: { include: { tools: { include: { versions: { orderBy: { version: "desc" }, take: 1 } } } } } },
    }));
    if (!connection?.connector) return;
    if (connection.expires_at && connection.expires_at <= new Date()) {
      await this.save(organizationId, connectionId, "expired", { reason: "expired" });
      return;
    }
    if (connection.connector.auth_type !== "none" && !connection.secret_locator) {
      await this.save(organizationId, connectionId, "error", { reason: "missing_secret" });
      return;
    }
    const check = connection.connector.tools.find((tool) => {
      if (tool.risk !== "read") return false;
      const spec = tool.versions[0]?.spec as { studio_function?: { handler?: string; method?: string; base_url?: string; path?: string } } | undefined;
      const fn = spec?.studio_function;
      return fn?.handler === "http_api" && fn.method === "GET" && Boolean(fn.base_url && fn.path) && !fn.path!.includes("{");
    });
    // 安全なread-only probeが無いProviderは、設定・期限だけを確認する。
    if (!check) {
      await this.save(organizationId, connectionId, "connected", { mode: "configuration" });
      return;
    }
    const spec = check.versions[0]!.spec as unknown as { studio_function: { base_url: string; path: string } };
    const url = await this.validateUrl(`${spec.studio_function.base_url}${spec.studio_function.path}`);
    const headers: Record<string, string> = { accept: "application/json", "user-agent": "agent-studio-provider-health" };
    if (connection.connector.auth_type !== "none") {
      const secret = await this.deps.secrets.get(connection.secret_locator!);
      if (!secret) {
        await this.save(organizationId, connectionId, "error", { reason: "secret_unavailable", tool: check.name });
        return;
      }
      const header = (connection.header_name ?? "Authorization").toLowerCase();
      headers[header] = header === "authorization" && !/^\S+\s/.test(secret) ? `Bearer ${secret}` : secret;
    }
    let status: ConnectionDto["status"] = "error";
    let httpStatus: number | null = null;
    try {
      const response = await this.fetchImpl(url, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
      httpStatus = response.status;
      await response.body?.cancel().catch(() => undefined);
      status = response.ok ? "connected" : response.status === 401 || response.status === 403 ? "expired" : "error";
    } catch {
      status = "error";
    }
    await this.save(organizationId, connectionId, status, { connector_id: connection.connector_id, tool: check.name, http_status: httpStatus });
  }

  private async save(organizationId: string, connectionId: string, status: ConnectionDto["status"], detail: Record<string, unknown>) {
    await this.deps.db.org(organizationId, async (tx) => {
      const current = await tx.connections.findFirst({ where: { id: connectionId, organization_id: organizationId } });
      if (!current || current.revoked_at) return;
      await tx.connections.update({ where: { id: connectionId }, data: { status, last_validated_at: new Date() } });
      await tx.audit_logs.createMany({ data: [{
        organization_id: organizationId,
        actor_type: "system",
        action: "connection.health_check",
        target_type: "connection",
        target_id: connectionId,
        result: status === "connected" ? "success" : "failure",
        detail: detail as Prisma.InputJsonValue,
      }] });

      const links = await tx.agent_connection_links.findMany({ where: { organization_id: organizationId, connection_id: connectionId } });
      for (const link of links) {
        const deployments = await tx.deployments.findMany({
          where: { organization_id: organizationId, agent_id: link.agent_id, stage: link.stage, status: "active" },
          include: { runtime_profile: { include: { runtime: true } } },
        });
        const stageLinks = await tx.agent_connection_links.findMany({
          where: { organization_id: organizationId, agent_id: link.agent_id, stage: link.stage },
          include: { connection: true },
        });
        for (const deployment of deployments) {
          const runtimeStatus = deployment.runtime_profile.runtime?.status;
          const unhealthyConnection = stageLinks.some((candidate) => candidate.connection.status !== "connected");
          const health = runtimeStatus === "offline" || runtimeStatus === "revoked"
            ? "failed"
            : (runtimeStatus && runtimeStatus !== "active") || unhealthyConnection
              ? "degraded"
              : deployment.health_status === "failed"
                ? "failed"
                : "ready";
          if (health !== deployment.health_status) {
            await tx.deployments.update({ where: { id: deployment.id }, data: { health_status: health } });
          }
        }
      }
    });
  }
}
