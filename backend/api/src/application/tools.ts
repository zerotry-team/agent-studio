import type { Prisma } from "@prisma/client";
import {
  createToolInputSchema,
  createConnectorSchema,
  toolVersionSpecSchema,
  type ConnectorDto,
  type ConnectionDto,
  type CreateConnectionInput,
  type CreateConnectorInput,
  type CreateToolInput,
  type CreateToolVersionInput,
  type SetConnectionSecretInput,
  type ToolDto,
  type ToolVersionDto,
} from "@agent-studio/contracts";
import { conflict, notFound, preconditionFailed, validationError } from "../domain/errors.js";
import { recordAudit } from "../infrastructure/audit.js";
import { assertPublicUrl } from "../infrastructure/http/public-url.js";
import { secretNames } from "../infrastructure/secrets/secret-store.js";
import { auditBy, requireRole, scopeOf, type MemberActor } from "./context.js";
import type { Deps } from "./deps.js";
import { toConnectionDto, toConnectorDto, toToolDto, toToolVersionDto } from "./dto.js";

export class ToolService {
  constructor(private readonly deps: Deps) {}

  async list(actor: MemberActor): Promise<ToolDto[]> {
    return this.deps.db.run(scopeOf(actor), async (tx) =>
      (await tx.tools.findMany({ where: { organization_id: actor.organizationId }, orderBy: { name: "asc" } })).map((t) => toToolDto(t)),
    );
  }

  async listConnectors(actor: MemberActor): Promise<ConnectorDto[]> {
    return this.deps.db.run(scopeOf(actor), async (tx) =>
      (
        await tx.connectors.findMany({
          where: { organization_id: actor.organizationId },
          include: { tools: { include: { versions: true }, orderBy: { name: "asc" } } },
          orderBy: { name: "asc" },
        })
      ).map(toConnectorDto),
    );
  }

  async getConnector(actor: MemberActor, id: string): Promise<ConnectorDto> {
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const connector = await tx.connectors.findFirst({
        where: { id, organization_id: actor.organizationId },
        include: { tools: { include: { versions: true }, orderBy: { name: "asc" } } },
      });
      if (!connector) throw notFound("連携サービス");
      return toConnectorDto(connector);
    });
  }

  /** 1サービスの複数能力を1トランザクションで登録する（AV-022）。 */
  async createConnector(actor: MemberActor, raw: CreateConnectorInput): Promise<ConnectorDto> {
    requireRole(actor, "builder");
    const input = createConnectorSchema.parse(raw);
    if (!(["http_openapi", "runtime"] as const).includes(input.adapter as "http_openapi" | "runtime")) {
      throw validationError("MVPではHTTP連携とBrowser連携の一括登録に対応しています");
    }
    const runtime = input.adapter === "runtime";
    const baseUrl = input.base_url?.replace(/\/$/, "") ?? null;
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const duplicate = await tx.connectors.findUnique({
        where: { organization_id_key: { organization_id: actor.organizationId, key: input.key } },
      });
      if (duplicate) throw conflict(`連携サービス ${input.key} はすでにあります`);
      const connector = await tx.connectors.create({
        data: {
          organization_id: actor.organizationId,
          key: input.key,
          name: input.name,
          description: input.description,
          adapter: input.adapter,
          base_url: baseUrl,
          auth_type: input.auth_type,
          tools: {
            create: input.operations.map((operation) => ({
              name: operation.name,
              display_name: operation.display_name,
              execution_location: runtime ? "runtime_mcp" : "studio_function",
              risk: operation.risk,
              latest_version: 1,
              versions: {
                create: {
                  version: 1,
                  created_by: actor.userId,
                  spec: runtime
                    ? ({
                        execution_location: "runtime_mcp",
                        description: operation.description,
                        input_schema: operation.input_schema,
                        risk: operation.risk,
                        reads_untrusted_content: true,
                      } as Prisma.InputJsonValue)
                    : ({
                    execution_location: "studio_function",
                    description: operation.description,
                    input_schema: operation.input_schema,
                    risk: operation.risk,
                    studio_function: {
                      handler: "http_api",
                      base_url: baseUrl!,
                      method: operation.method!,
                      path: operation.path!,
                      argument_location: operation.method === "GET" || operation.method === "DELETE" ? "query" : "body",
                      ...(operation.idempotency_key_field ? { idempotency_key_field: operation.idempotency_key_field } : {}),
                    },
                  } as Prisma.InputJsonValue),
                },
              },
            })),
          },
        },
        include: { tools: { include: { versions: true } } },
      });
      await recordAudit(
        tx,
        auditBy(actor, {
          action: "connector.create",
          targetType: "connector",
          targetId: connector.id,
          detail: { key: connector.key, capabilities: input.operations.map((operation) => operation.name) },
        }),
      );
      return toConnectorDto(connector);
    });
  }

  async get(actor: MemberActor, id: string): Promise<ToolDto> {
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const tool = await tx.tools.findFirst({ where: { id, organization_id: actor.organizationId }, include: { versions: true } });
      if (!tool) throw notFound("ツール");
      return toToolDto(tool, true);
    });
  }

  async create(actor: MemberActor, raw: CreateToolInput): Promise<ToolDto> {
    requireRole(actor, "builder");
    const input = createToolInputSchema.parse(raw);
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const dup = await tx.tools.findUnique({ where: { organization_id_name: { organization_id: actor.organizationId, name: input.name } } });
      if (dup) throw conflict(`ツール ${input.name} はすでにあります`);
      await this.assertConnectionRefs(tx, actor.organizationId, input.spec);
      const tool = await tx.tools.create({
        data: {
          organization_id: actor.organizationId,
          name: input.name,
          display_name: input.display_name,
          execution_location: input.spec.execution_location,
          risk: input.spec.risk,
          latest_version: 1,
          versions: {
            // organization_id は複合外部キーにより親（tools）から入る
            create: {
              version: 1,
              spec: input.spec as Prisma.InputJsonValue,
              created_by: actor.userId,
            },
          },
        },
        include: { versions: true },
      });
      await recordAudit(tx, auditBy(actor, { action: "tool.create", targetType: "tool", targetId: tool.id, detail: { name: tool.name, execution_location: tool.execution_location } }));
      return toToolDto(tool, true);
    });
  }

  async addVersion(actor: MemberActor, id: string, raw: CreateToolVersionInput): Promise<ToolVersionDto> {
    requireRole(actor, "builder");
    const spec = toolVersionSpecSchema.parse(raw.spec);
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const tool = await tx.tools.findFirst({ where: { id, organization_id: actor.organizationId } });
      if (!tool) throw notFound("ツール");
      if (tool.execution_location !== spec.execution_location) {
        throw validationError("実行場所は変更できません。別のツールとして作成してください");
      }
      await this.assertConnectionRefs(tx, actor.organizationId, spec);
      const version = tool.latest_version + 1;
      const created = await tx.tool_versions.create({
        data: { organization_id: actor.organizationId, tool_id: id, version, spec: spec as Prisma.InputJsonValue, created_by: actor.userId },
      });
      await tx.tools.update({ where: { id }, data: { latest_version: version, risk: spec.risk } });
      await recordAudit(tx, auditBy(actor, { action: "tool.version.create", targetType: "tool", targetId: id, detail: { version } }));
      return toToolVersionDto(created);
    });
  }

  private async assertConnectionRefs(tx: Prisma.TransactionClient, organizationId: string, spec: CreateToolInput["spec"]) {
    const connectionId =
      spec.execution_location === "studio_function"
        ? "connection_id" in spec.studio_function
          ? spec.studio_function.connection_id
          : undefined
        : spec.execution_location === "openai_service_mcp"
          ? spec.service_mcp.connection_id
          : undefined;
    if (!connectionId) return;
    const conn = await tx.connections.findFirst({ where: { id: connectionId, organization_id: organizationId } });
    if (!conn) throw validationError("指定した接続先が見つかりません");
    const expected = spec.execution_location === "studio_function" ? "studio" : "openai_vault";
    if (conn.scope !== expected) throw validationError("このツールでは使えない種類の接続先です");
  }

  // ---------------------------------------------------------------------------
  // 接続先（CONN）
  // ---------------------------------------------------------------------------
  async listConnections(actor: MemberActor): Promise<ConnectionDto[]> {
    return this.deps.db.run(scopeOf(actor), async (tx) =>
      (await tx.connections.findMany({ where: { organization_id: actor.organizationId }, orderBy: { name: "asc" } })).map(toConnectionDto),
    );
  }

  async createConnection(actor: MemberActor, input: CreateConnectionInput): Promise<ConnectionDto> {
    requireRole(actor, "admin");
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      if (input.connector_id) {
        const connector = await tx.connectors.findFirst({ where: { id: input.connector_id, organization_id: actor.organizationId } });
        if (!connector) throw validationError("指定した連携サービスが見つかりません");
        if (connector.auth_type === "static_bearer" && input.scope !== "studio") {
          throw validationError("この連携サービスの認証情報はAgent Studioに保存します");
        }
      }
      if (input.scope === "runtime") {
        const runtime = await tx.runtimes.findFirst({ where: { id: input.runtime_id!, organization_id: actor.organizationId } });
        if (!runtime) throw validationError("指定した Runtime が見つかりません");
      }
      const dup = await tx.connections.findUnique({ where: { organization_id_name: { organization_id: actor.organizationId, name: input.name } } });
      if (dup) throw conflict("同じ名前の接続先があります");
      const c = await tx.connections.create({
        data: {
          organization_id: actor.organizationId,
          connector_id: input.connector_id ?? null,
          name: input.name,
          description: input.description ?? null,
          scope: input.scope,
          runtime_id: input.scope === "runtime" ? input.runtime_id! : null,
          runtime_secret_name: input.scope === "runtime" ? input.runtime_secret_name! : null,
          header_name: input.scope === "studio" ? (input.header_name ?? "Authorization") : null,
        },
      });
      await recordAudit(tx, auditBy(actor, { action: "connection.create", targetType: "connection", targetId: c.id, detail: { name: c.name, scope: c.scope } }));
      return toConnectionDto(c);
    });
  }

  /** 認証情報の値を設定する。値は DB に保存しない（CONN-02） */
  async setConnectionSecret(actor: MemberActor, id: string, input: SetConnectionSecretInput): Promise<void> {
    requireRole(actor, "admin");
    const conn = await this.deps.db.run(scopeOf(actor), (tx) =>
      tx.connections.findFirst({ where: { id, organization_id: actor.organizationId } }),
    );
    if (!conn) throw notFound("接続先");

    let locator: string;
    if (conn.scope === "studio") {
      locator = await this.deps.secrets.put(secretNames.connection(this.deps.env.SECRETS_PREFIX, actor.organizationId, id), input.value, {
        "agentstudio:organization_id": actor.organizationId,
      });
    } else if (conn.scope === "openai_vault") {
      if (!input.mcp_server_url) throw validationError("この認証情報を使う MCP サーバーの URL を指定してください");
      const api = await this.deps.agentsApi.forOrganization(actor.organizationId);
      if (!api.storeVaultCredential) throw preconditionFailed("この環境では OpenAI の vault を使えません");
      const stored = await api.storeVaultCredential({
        organizationId: actor.organizationId,
        name: conn.name,
        token: input.value,
        mcpServerUrl: input.mcp_server_url,
      });
      locator = `${stored.vaultId}:${stored.credentialId}`;
    } else {
      throw preconditionFailed(
        "この接続先の認証情報は、企業の AWS アカウントの Secrets Manager に登録してください（Agent Studio には保存しません）",
      );
    }

    await this.deps.db.run(scopeOf(actor), async (tx) => {
      await tx.connections.update({
        where: { id },
        data: {
          secret_locator: locator,
          status: input.expires_at && new Date(input.expires_at) <= new Date() ? "expired" : "connected",
          last_validated_at: new Date(),
          expires_at: input.expires_at ? new Date(input.expires_at) : null,
          revoked_at: null,
        },
      });
      await recordAudit(tx, auditBy(actor, { action: "connection.secret.set", targetType: "connection", targetId: id, detail: { scope: conn.scope } }));
    });
  }

  /** 読み取り専用の代表操作を1回呼び、Connectionが実際に利用できるか確認する。 */
  async validateConnection(actor: MemberActor, id: string): Promise<ConnectionDto> {
    requireRole(actor, "admin");
    const conn = await this.deps.db.run(scopeOf(actor), (tx) =>
      tx.connections.findFirst({
        where: { id, organization_id: actor.organizationId },
        include: { connector: { include: { tools: { include: { versions: { orderBy: { version: "desc" }, take: 1 } } } } } },
      }),
    );
    if (!conn) throw notFound("接続先");
    if (conn.revoked_at) throw preconditionFailed("このConnectionは失効しています。認証情報を再設定してください");
    if (conn.expires_at && conn.expires_at <= new Date()) {
      return this.updateConnectionStatus(actor, conn.id, "expired", "connection.validate", { reason: "expired" });
    }
    if (conn.scope !== "studio" || !conn.connector || conn.connector.adapter !== "http_openapi") {
      if (!conn.secret_locator && conn.scope !== "runtime") throw preconditionFailed("認証情報が設定されていません");
      return this.updateConnectionStatus(actor, conn.id, "connected", "connection.validate", { mode: "configuration" });
    }
    if (!conn.secret_locator) throw preconditionFailed("認証情報が設定されていません");

    const check = conn.connector.tools.find((tool) => {
      if (tool.risk !== "read") return false;
      const spec = tool.versions[0]?.spec as { studio_function?: { handler?: string; method?: string; base_url?: string; path?: string } } | undefined;
      const fn = spec?.studio_function;
      return fn?.handler === "http_api" && fn.method === "GET" && Boolean(fn.base_url && fn.path) && !fn.path!.includes("{");
    });
    if (!check) throw preconditionFailed("この連携サービスには自動確認に使える読み取り操作がありません");
    const spec = check.versions[0]!.spec as unknown as { studio_function: { base_url: string; path: string } };
    const url = await assertPublicUrl(`${spec.studio_function.base_url}${spec.studio_function.path}`);
    const secret = await this.deps.secrets.get(conn.secret_locator);
    if (!secret) throw preconditionFailed("認証情報を読み込めませんでした。もう一度設定してください");
    const header = (conn.header_name ?? "Authorization").toLowerCase();
    const value = header === "authorization" && !/^\S+\s/.test(secret) ? `Bearer ${secret}` : secret;
    let status: ConnectionDto["status"] = "error";
    let httpStatus: number | null = null;
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json", "user-agent": "agent-studio-connection-check", [header]: value },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      httpStatus = response.status;
      status = response.ok ? "connected" : response.status === 401 || response.status === 403 ? "expired" : "error";
    } catch {
      status = "error";
    }
    return this.updateConnectionStatus(actor, conn.id, status, "connection.validate", {
      connector_id: conn.connector_id,
      tool: check.name,
      http_status: httpStatus,
    });
  }

  /** Connectionを即時に利用不可にする。保管先の値を再び参照できないようlocatorも切り離す。 */
  async revokeConnection(actor: MemberActor, id: string): Promise<ConnectionDto> {
    requireRole(actor, "admin");
    const conn = await this.deps.db.run(scopeOf(actor), (tx) =>
      tx.connections.findFirst({ where: { id, organization_id: actor.organizationId } }),
    );
    if (!conn) throw notFound("接続先");
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const updated = await tx.connections.update({
        where: { id },
        data: { status: "revoked", revoked_at: new Date(), secret_locator: null },
      });
      await recordAudit(tx, auditBy(actor, { action: "connection.revoke", targetType: "connection", targetId: id }));
      return toConnectionDto(updated);
    });
  }

  private async updateConnectionStatus(
    actor: MemberActor,
    id: string,
    status: ConnectionDto["status"],
    action: string,
    detail: Record<string, unknown>,
  ): Promise<ConnectionDto> {
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const updated = await tx.connections.update({ where: { id }, data: { status, last_validated_at: new Date() } });
      await recordAudit(tx, auditBy(actor, { action, targetType: "connection", targetId: id, result: status === "connected" ? "success" : "failure", detail }));
      return toConnectionDto(updated);
    });
  }

  async deleteConnection(actor: MemberActor, id: string): Promise<void> {
    requireRole(actor, "admin");
    await this.deps.db.run(scopeOf(actor), async (tx) => {
      const conn = await tx.connections.findFirst({ where: { id, organization_id: actor.organizationId } });
      if (!conn) throw notFound("接続先");
      await tx.connections.delete({ where: { id } });
      await recordAudit(tx, auditBy(actor, { action: "connection.delete", targetType: "connection", targetId: id, detail: { name: conn.name } }));
    });
  }
}
