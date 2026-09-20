import type { Prisma } from "@prisma/client";
import {
  createToolInputSchema,
  createConnectorSchema,
  setConnectorOAuthAppSchema,
  updateConnectorSchema,
  discoverMcpToolsSchema,
  toolVersionSpecSchema,
  type ConnectorDto,
  type ConnectorOAuthAppDto,
  type ConnectorOperationInput,
  type DiscoverMcpToolsInput,
  type UpdateConnectorInput,
  type DiscoverMcpToolsResultDto,
  type ConnectionDto,
  type CreateConnectionInput,
  type CreateConnectorInput,
  type CreateToolInput,
  type CreateToolVersionInput,
  type SetConnectionSecretInput,
  type SetConnectorOAuthAppInput,
  type ToolDto,
  type ToolVersionDto,
} from "@agent-studio/contracts";
import { conflict, notFound, preconditionFailed, validationError } from "../domain/errors.js";
import { recordAudit } from "../infrastructure/audit.js";
import { assertPublicUrl } from "../infrastructure/http/public-url.js";
import { discoverMcpTools } from "../infrastructure/mcp/discover.js";
import { secretNames } from "../infrastructure/secrets/secret-store.js";
import { auditBy, requireRole, scopeOf, type MemberActor } from "./context.js";
import type { Deps } from "./deps.js";
import { toConnectionDto, toConnectorDto, toToolDto, toToolVersionDto } from "./dto.js";

/** jsonb はキーの順序を保たないので、順序に依存しない形にしてから比べる */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function usableEnvSecret(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "unset" ? trimmed : null;
}

/** 連携サービスの1操作から、ツールの spec を組み立てる（登録と編集で同じ形にする） */
function buildConnectorToolSpec(
  adapter: string,
  baseUrl: string | null,
  defaultHeaders: Record<string, string> | undefined,
  operation: ConnectorOperationInput,
): { executionLocation: string; spec: Prisma.InputJsonValue } {
  if (adapter === "runtime") {
    return {
      executionLocation: "runtime_mcp",
      spec: {
        execution_location: "runtime_mcp",
        description: operation.description,
        input_schema: operation.input_schema,
        risk: operation.risk,
        reads_untrusted_content: true,
      } as Prisma.InputJsonValue,
    };
  }
  if (adapter === "mcp") {
    return {
      executionLocation: "openai_service_mcp",
      spec: {
        execution_location: "openai_service_mcp",
        description: operation.description,
        risk: operation.risk,
        // 接続先のMCPサーバーが持つ同名の操作だけを許可する。認証はConnectionから実行時に解決する。
        service_mcp: { server_url: baseUrl!, allowed_tools: [operation.name] },
      } as Prisma.InputJsonValue,
    };
  }
  return {
    executionLocation: "studio_function",
    spec: {
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
        ...(defaultHeaders && Object.keys(defaultHeaders).length > 0 ? { headers: defaultHeaders } : {}),
        ...(operation.idempotency_key_field ? { idempotency_key_field: operation.idempotency_key_field } : {}),
      },
    } as Prisma.InputJsonValue,
  };
}

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

  /** OAuth applicationの準備状況。Client Secretは存在の有無だけを返す。 */
  async getConnectorOAuthApp(actor: MemberActor, id: string): Promise<ConnectorOAuthAppDto> {
    const connector = await this.deps.db.run(scopeOf(actor), (tx) =>
      tx.connectors.findFirst({ where: { id, organization_id: actor.organizationId } }),
    );
    if (!connector) throw notFound("連携サービス");
    if (connector.key !== "qiita") throw validationError("この連携サービスはOAuth application設定に対応していません");
    const envClientId = usableEnvSecret(this.deps.env.QIITA_OAUTH_CLIENT_ID);
    const envClientSecret = usableEnvSecret(this.deps.env.QIITA_OAUTH_CLIENT_SECRET);
    const clientId = connector.oauth_client_id ?? envClientId;
    const hasClientSecret = Boolean(connector.oauth_client_secret_locator || envClientSecret);
    return {
      connector_id: connector.id,
      provider: connector.key,
      configured: Boolean(clientId && hasClientSecret),
      client_id: clientId ?? null,
      has_client_secret: hasClientSecret,
    };
  }

  /** OAuth applicationを運営者が一度だけ登録する。Secret本体はSecret Store以外へ保存しない。 */
  async setConnectorOAuthApp(actor: MemberActor, id: string, raw: SetConnectorOAuthAppInput): Promise<ConnectorOAuthAppDto> {
    requireRole(actor, "owner");
    const input = setConnectorOAuthAppSchema.parse(raw);
    const connector = await this.deps.db.run(scopeOf(actor), (tx) =>
      tx.connectors.findFirst({ where: { id, organization_id: actor.organizationId } }),
    );
    if (!connector) throw notFound("連携サービス");
    if (connector.key !== "qiita") throw validationError("この連携サービスはOAuth application設定に対応していません");
    const locator = await this.deps.secrets.put(
      secretNames.connectorOAuthApp(this.deps.env.SECRETS_PREFIX, actor.organizationId, connector.id),
      input.client_secret,
      { "agentstudio:organization_id": actor.organizationId, "agentstudio:connector_id": connector.id },
    );
    await this.deps.db.run(scopeOf(actor), async (tx) => {
      await tx.connectors.update({
        where: { id: connector.id },
        data: { oauth_client_id: input.client_id, oauth_client_secret_locator: locator },
      });
      await recordAudit(
        tx,
        auditBy(actor, {
          action: "connector.oauth_app.update",
          targetType: "connector",
          targetId: connector.id,
          detail: { provider: connector.key, client_id_updated: true, client_secret_updated: true },
        }),
      );
    });
    return {
      connector_id: connector.id,
      provider: connector.key,
      configured: true,
      client_id: input.client_id,
      has_client_secret: true,
    };
  }

  /** 登録前に MCP サーバーへ接続し、申告されている操作の一覧を返す（入力補助）。 */
  async discoverMcpTools(actor: MemberActor, raw: DiscoverMcpToolsInput): Promise<DiscoverMcpToolsResultDto> {
    requireRole(actor, "builder");
    const input = discoverMcpToolsSchema.parse(raw);
    return { tools: await discoverMcpTools(input.server_url) };
  }

  /** 1サービスの複数能力を1トランザクションで登録する（AV-022）。 */
  async createConnector(actor: MemberActor, raw: CreateConnectorInput): Promise<ConnectorDto> {
    requireRole(actor, "builder");
    const input = createConnectorSchema.parse(raw);
    if (!(["http_openapi", "runtime", "mcp"] as const).includes(input.adapter as "http_openapi" | "runtime" | "mcp")) {
      throw validationError("HTTP連携、MCP連携、Browser連携の一括登録に対応しています");
    }
    const runtime = input.adapter === "runtime";
    const mcp = input.adapter === "mcp";
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
            create: input.operations.map((operation) => {
              const built = buildConnectorToolSpec(input.adapter, baseUrl, input.default_headers, operation);
              return {
                name: operation.name,
                display_name: operation.display_name,
                execution_location: built.executionLocation,
                risk: operation.risk,
                latest_version: 1,
                versions: { create: { version: 1, created_by: actor.userId, spec: built.spec } },
              };
            }),
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

  /**
   * 連携サービスを編集する。振る舞いが変わる操作はツールの新しいバージョンになる。
   * 公開済みの Build は作成時の定義を持っているため影響を受けず、次の Build から反映される。
   */
  async updateConnector(actor: MemberActor, id: string, raw: UpdateConnectorInput): Promise<ConnectorDto> {
    requireRole(actor, "builder");
    const input = updateConnectorSchema.parse(raw);
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const connector = await tx.connectors.findFirst({
        where: { id, organization_id: actor.organizationId },
        include: { tools: { include: { versions: { orderBy: { version: "desc" }, take: 1 } } } },
      });
      if (!connector) throw notFound("連携サービス");
      if (connector.adapter === "http_openapi" && !input.base_url) throw validationError("HTTP連携にはbase_urlが必要です");
      if (connector.adapter === "mcp" && !input.base_url) throw validationError("MCP連携にはサーバーのURLが必要です");
      if (connector.adapter !== "http_openapi" && input.default_headers) {
        throw validationError("固定ヘッダはHTTP連携でだけ指定できます");
      }

      const baseUrl = input.base_url?.replace(/\/$/, "") ?? null;
      const keep = new Set(input.operations.map((operation) => operation.name));
      const removed = connector.tools.filter((tool) => !keep.has(tool.name));
      if (removed.length > 0) {
        // 使っている Agent がある操作は消させない（Build で参照できなくなるため）
        const links = await tx.agent_connection_links.findMany({
          where: { organization_id: actor.organizationId, connector_id: connector.id },
          select: { allowed_capabilities: true },
        });
        const inUse = removed.filter((tool) => links.some((link) => (link.allowed_capabilities as string[]).includes(tool.name)));
        if (inUse.length > 0) {
          throw preconditionFailed(`${inUse.map((tool) => tool.display_name).join("、")} はAgentが使っているため削除できません`);
        }
        await tx.tool_versions.deleteMany({ where: { tool_id: { in: removed.map((tool) => tool.id) } } });
        await tx.tools.deleteMany({ where: { id: { in: removed.map((tool) => tool.id) } } });
      }

      await tx.connectors.update({
        where: { id: connector.id },
        data: { name: input.name, description: input.description, base_url: baseUrl },
      });

      for (const operation of input.operations) {
        const built = buildConnectorToolSpec(connector.adapter, baseUrl, input.default_headers, operation);
        const existing = connector.tools.find((tool) => tool.name === operation.name);
        if (!existing) {
          await tx.tools.create({
            data: {
              organization_id: actor.organizationId,
              connector_id: connector.id,
              name: operation.name,
              display_name: operation.display_name,
              execution_location: built.executionLocation,
              risk: operation.risk,
              latest_version: 1,
              versions: { create: { version: 1, created_by: actor.userId, spec: built.spec } },
            },
          });
          continue;
        }
        // 振る舞いが同じなら新しいバージョンを作らない
        const current = existing.versions[0]?.spec as unknown;
        const changed = canonicalJson(current) !== canonicalJson(built.spec);
        await tx.tools.update({
          where: { id: existing.id },
          data: {
            display_name: operation.display_name,
            risk: operation.risk,
            ...(changed
              ? {
                  latest_version: existing.latest_version + 1,
                  versions: { create: { version: existing.latest_version + 1, created_by: actor.userId, spec: built.spec } },
                }
              : {}),
          },
        });
      }

      await recordAudit(
        tx,
        auditBy(actor, {
          action: "connector.update",
          targetType: "connector",
          targetId: connector.id,
          detail: { key: connector.key, capabilities: input.operations.map((operation) => operation.name), removed: removed.map((tool) => tool.name) },
        }),
      );
      const updated = await tx.connectors.findFirstOrThrow({
        where: { id: connector.id, organization_id: actor.organizationId },
        include: { tools: { include: { versions: true } } },
      });
      return toConnectorDto(updated);
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

  /** Qiita OAuth codeをtokenへ交換し、そのままAgent Studio Connectionとして保存する。 */
  async exchangeQiitaOAuth(actor: MemberActor, connectorId: string, code: string): Promise<ConnectionDto> {
    requireRole(actor, "admin");
    const connector = await this.deps.db.run(scopeOf(actor), (tx) =>
      tx.connectors.findFirst({ where: { id: connectorId, organization_id: actor.organizationId, key: "qiita" } }),
    );
    if (!connector) throw notFound("Qiita連携");
    const clientId = connector.oauth_client_id ?? usableEnvSecret(this.deps.env.QIITA_OAUTH_CLIENT_ID);
    const storedClientSecret = connector.oauth_client_secret_locator
      ? await this.deps.secrets.get(connector.oauth_client_secret_locator)
      : null;
    const clientSecret = storedClientSecret ?? usableEnvSecret(this.deps.env.QIITA_OAUTH_CLIENT_SECRET);
    if (!clientId || !clientSecret) {
      throw preconditionFailed("Qiita OAuthがまだAgent Studioに設定されていません");
    }

    const exchanged = await fetch("https://qiita.com/api/v2/access_tokens", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": "agent-studio-qiita-oauth" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const tokenBody = (await exchanged.json().catch(() => null)) as { token?: unknown; scopes?: unknown } | null;
    if (!exchanged.ok || typeof tokenBody?.token !== "string") {
      throw preconditionFailed(`Qiitaの認証を完了できませんでした（HTTP ${exchanged.status}）`);
    }
    const scopes = Array.isArray(tokenBody.scopes) ? tokenBody.scopes.filter((scope): scope is string => typeof scope === "string") : [];
    if (!scopes.includes("write_qiita")) throw preconditionFailed("Qiitaの記事公開に必要なwrite_qiita権限が許可されていません");

    const me = await fetch("https://qiita.com/api/v2/authenticated_user", {
      headers: { accept: "application/json", authorization: `Bearer ${tokenBody.token}`, "user-agent": "agent-studio-qiita-oauth" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const user = (await me.json().catch(() => null)) as { id?: unknown } | null;
    if (!me.ok || typeof user?.id !== "string" || !user.id.trim()) {
      throw preconditionFailed("Qiitaアカウントを確認できませんでした");
    }
    const qiitaUserId = user.id.trim();
    const description = `qiita-user:${qiitaUserId}`;
    const connection = await this.deps.db.run(scopeOf(actor), async (tx) => {
      const existing = await tx.connections.findFirst({
        where: { organization_id: actor.organizationId, connector_id: connector.id, description },
      });
      if (existing) return existing;
      return tx.connections.create({
        data: {
          organization_id: actor.organizationId,
          connector_id: connector.id,
          name: `Qiita (${qiitaUserId})`,
          description,
          scope: "studio",
          header_name: "Authorization",
        },
      });
    });
    const locator = await this.deps.secrets.put(
      secretNames.connection(this.deps.env.SECRETS_PREFIX, actor.organizationId, connection.id),
      tokenBody.token,
      { "agentstudio:organization_id": actor.organizationId },
    );
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const updated = await tx.connections.update({
        where: { id: connection.id },
        data: { secret_locator: locator, status: "connected", last_validated_at: new Date(), expires_at: null, revoked_at: null },
      });
      await recordAudit(
        tx,
        auditBy(actor, {
          action: "connection.oauth.connected",
          targetType: "connection",
          targetId: connection.id,
          detail: { connector_id: connector.id, provider: "qiita", qiita_user_id: qiitaUserId, scopes },
        }),
      );
      return toConnectionDto(updated);
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
