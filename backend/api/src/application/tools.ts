import type { Prisma, connections } from "@prisma/client";
import type { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  createToolInputSchema,
  createGitHubAppConnectionSchema,
  createConnectorSchema,
  updateConnectorSchema,
  discoverMcpToolsSchema,
  toolVersionSpecSchema,
  type ConnectorDto,
  type ConnectorOperationInput,
  type DiscoverMcpToolsInput,
  type UpdateConnectorInput,
  type DiscoverMcpToolsResultDto,
  type ConnectionDto,
  type CreateConnectionInput,
  type CreateGitHubAppConnectionInput,
  type CreateConnectorInput,
  type CreateToolInput,
  type CreateToolVersionInput,
  type ProviderCatalogEntryDto,
  type SetConnectionSecretInput,
  type ToolDto,
  type ToolVersionDto,
} from "@agent-studio/contracts";
import { conflict, notFound, preconditionFailed, validationError } from "../domain/errors.js";
import {
  PROVIDER_CATALOG,
  connectorAuthTypeFor,
  selectOperations,
  toCatalogEntryDto,
  toConnectorOperation,
  type ProviderCatalogEntry,
} from "../domain/provider-catalog.js";
import { recordAudit } from "../infrastructure/audit.js";
import { assertPublicUrl } from "../infrastructure/http/public-url.js";
import { secretNames } from "../infrastructure/secrets/secret-store.js";
import { parseGitHubAppMetadata, parseGitHubAppSecret, type GitHubAppSecret } from "../infrastructure/git/github-app.js";
import { validatePackageSigningPublicKey } from "../infrastructure/git/adapter-signature.js";
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
        reads_untrusted_content: true,
        // 接続先のMCPサーバーが持つ同名の操作だけを許可する。認証はConnectionから実行時に解決する。
        input_schema: operation.input_schema,
        service_mcp: { server_url: baseUrl!, allowed_tools: [operation.provider_operation_name ?? operation.name] },
      } as Prisma.InputJsonValue,
    };
  }
  return {
    executionLocation: "studio_function",
    spec: {
      execution_location: "studio_function",
      description: operation.description,
      input_schema: operation.input_schema,
      ...(operation.output_schema ? { output_schema: operation.output_schema } : {}),
      risk: operation.risk,
      studio_function: {
        handler: "http_api",
        base_url: baseUrl!,
        method: operation.method!,
        path: operation.path!,
        argument_location: operation.method === "GET" || operation.method === "DELETE" ? "query" : "body",
        ...(defaultHeaders && Object.keys(defaultHeaders).length > 0 ? { headers: defaultHeaders } : {}),
        ...(operation.idempotency_key_field ? { idempotency_key_field: operation.idempotency_key_field } : {}),
        ...(operation.response_boundary ? { response_boundary: operation.response_boundary } : {}),
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

  /** 登録前に MCP サーバーへ接続し、申告されている操作の一覧を返す（入力補助）。 */
  async discoverMcpTools(actor: MemberActor, raw: DiscoverMcpToolsInput): Promise<DiscoverMcpToolsResultDto> {
    requireRole(actor, "builder");
    const input = discoverMcpToolsSchema.parse(raw);
    return { tools: await this.deps.mcpDiscovery(input.server_url) };
  }

  /** 1サービスの複数能力を1トランザクションで登録する（AV-022）。 */
  async createConnector(actor: MemberActor, raw: CreateConnectorInput): Promise<ConnectorDto> {
    requireRole(actor, "builder");
    const input = createConnectorSchema.parse(raw);
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const duplicate = await tx.connectors.findUnique({
        where: { organization_id_key: { organization_id: actor.organizationId, key: input.key } },
      });
      if (duplicate) throw conflict(`連携サービス ${input.key} はすでにあります`);
      return this.createConnectorIn(tx, actor, input);
    });
  }

  /** Connector と操作を作る本体（重複検査は呼び出し側）。Builder のカタログ登録と手動登録で共有する。 */
  private async createConnectorIn(tx: Prisma.TransactionClient, actor: MemberActor, input: z.output<typeof createConnectorSchema>): Promise<ConnectorDto> {
    if (!(["http_openapi", "internal_http_api", "runtime", "mcp"] as const).includes(input.adapter as "http_openapi" | "internal_http_api" | "runtime" | "mcp")) {
      throw validationError("HTTP連携、MCP連携、Browser連携の一括登録に対応しています");
    }
    const baseUrl = input.base_url?.replace(/\/$/, "") ?? null;
    {
      const connector = await tx.connectors.create({
        data: {
          organization_id: actor.organizationId,
          key: input.key,
          provider_key: input.provider_key ?? null,
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
          detail: { key: connector.key, provider_key: input.provider_key ?? null, capabilities: input.operations.map((operation) => operation.name) },
        }),
      );
      return toConnectorDto(connector);
    }
  }

  /**
   * Provider Catalog のエントリから Connector を用意する。既にあれば再利用し、足りない操作だけ追加する。
   * 利用者に識別子・URL・操作一覧を入力させないための入口。Secret は扱わない。
   */
  async ensureCatalogConnector(
    actor: MemberActor,
    entry: ProviderCatalogEntry,
    requirementTexts: string[],
  ): Promise<{ connector: ConnectorDto; created: boolean; added_operations: string[] }> {
    requireRole(actor, "builder");
    if (entry.auth.kind === "github_app") throw validationError("GitHubは設定の詳細設定からGitHub Appで接続します");
    const selected = selectOperations(entry, requirementTexts);
    const operations = selected.map(toConnectorOperation);
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const existing = await tx.connectors.findFirst({
        where: { organization_id: actor.organizationId, OR: [{ provider_key: entry.key }, { key: entry.key }] },
        include: { tools: { include: { versions: true }, orderBy: { name: "asc" } } },
        orderBy: { created_at: "asc" },
      });
      if (!existing) {
        const connector = await this.createConnectorIn(tx, actor, createConnectorSchema.parse({
          key: entry.key,
          provider_key: entry.key,
          name: entry.name,
          description: entry.description,
          adapter: entry.adapter,
          ...(entry.base_url ? { base_url: entry.base_url } : {}),
          auth_type: connectorAuthTypeFor(entry),
          ...(entry.default_headers ? { default_headers: entry.default_headers } : {}),
          operations,
        }));
        return { connector, created: true, added_operations: operations.map((operation) => operation.name) };
      }
      const known = new Set(existing.tools.map((tool) => tool.name));
      const missing = operations.filter((operation) => !known.has(operation.name));
      const baseUrl = existing.base_url ?? entry.base_url?.replace(/\/$/, "") ?? null;
      for (const operation of missing) {
        const built = buildConnectorToolSpec(existing.adapter, baseUrl, entry.default_headers, operation);
        await tx.tools.create({
          data: {
            organization_id: actor.organizationId,
            connector_id: existing.id,
            name: operation.name,
            display_name: operation.display_name,
            execution_location: built.executionLocation,
            risk: operation.risk,
            latest_version: 1,
            versions: { create: { version: 1, created_by: actor.userId, spec: built.spec } },
          },
        });
      }
      if (!existing.provider_key || missing.length) {
        await tx.connectors.update({ where: { id: existing.id }, data: { provider_key: existing.provider_key ?? entry.key } });
        await recordAudit(tx, auditBy(actor, {
          action: "connector.catalog.reuse",
          targetType: "connector",
          targetId: existing.id,
          detail: { provider_key: entry.key, added_operations: missing.map((operation) => operation.name) },
        }));
      }
      const refreshed = await tx.connectors.findUniqueOrThrow({
        where: { id: existing.id },
        include: { tools: { include: { versions: true }, orderBy: { name: "asc" } } },
      });
      return { connector: toConnectorDto(refreshed), created: false, added_operations: missing.map((operation) => operation.name) };
    });
  }

  /** この組織で使えるカタログと、登録済み Connector の対応。 */
  async listCatalog(actor: MemberActor): Promise<ProviderCatalogEntryDto[]> {
    const connectors = await this.deps.db.run(scopeOf(actor), (tx) =>
      tx.connectors.findMany({ where: { organization_id: actor.organizationId }, select: { id: true, key: true, provider_key: true } }),
    );
    return PROVIDER_CATALOG.map((entry) => toCatalogEntryDto(entry, connectors.find((connector) => (connector.provider_key ?? connector.key) === entry.key)?.id ?? null));
  }

  /**
   * Builder が認証情報だけを利用者に求めるための Connection 枠を事前に作る（secret なし・status error）。
   * startPreview は connected しか拾わないので、誤って Build へ結び付くことはない。
   */
  async ensureManagedConnection(
    tx: Prisma.TransactionClient,
    organizationId: string,
    connector: { id: string; name: string; adapter: string },
    options: { headerName?: string | null; projectId?: string | null } = {},
  ): Promise<connections> {
    // 既存の枠を再利用するのは、Builder が用意したもの、または認証情報が未設定のものだけ。
    // 利用中（Production 用など）の Connection を上書き対象にしない
    const existing = await tx.connections.findFirst({
      where: {
        organization_id: organizationId,
        connector_id: connector.id,
        revoked_at: null,
        scope: { in: ["studio", "openai_vault"] },
        OR: [{ metadata: { path: ["managed_by"], equals: "builder" } }, { secret_locator: null }],
      },
      orderBy: { created_at: "asc" },
    });
    if (existing) return existing;
    const scope = connector.adapter === "mcp" ? "openai_vault" : "studio";
    const baseName = `${connector.name}（Preview用）`;
    let name = baseName;
    for (let attempt = 2; await tx.connections.findUnique({ where: { organization_id_name: { organization_id: organizationId, name } } }); attempt += 1) {
      name = `${baseName} ${attempt}`;
    }
    return tx.connections.create({
      data: {
        organization_id: organizationId,
        connector_id: connector.id,
        name,
        description: "Builderが自動で用意した接続枠。認証情報を設定すると利用できます",
        scope,
        header_name: scope === "studio" ? (options.headerName ?? "Authorization") : null,
        status: "error",
        metadata: { managed_by: "builder", ...(options.projectId ? { project_id: options.projectId } : {}) },
      },
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
      if ((connector.adapter === "http_openapi" || connector.adapter === "internal_http_api") && !input.base_url) throw validationError("HTTP連携にはbase_urlが必要です");
      if (connector.adapter === "mcp" && !input.base_url) throw validationError("MCP連携にはサーバーのURLが必要です");
      if (connector.adapter === "internal_http_api" && input.operations.some((operation) => !operation.output_schema || !operation.response_boundary)) {
        throw validationError("社内APIの各操作にはresponse schemaとfield allowlistが必要です");
      }
      if (connector.adapter !== "http_openapi" && connector.adapter !== "internal_http_api" && input.default_headers) {
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

  /** GitHub Appだけを使うrepository allowlist付きConnection。秘密鍵とwebhook secretはSecret Storeへ直行する。 */
  async createGitHubAppConnection(actor: MemberActor, raw: CreateGitHubAppConnectionInput): Promise<ConnectionDto> {
    requireRole(actor, "admin");
    const input = createGitHubAppConnectionSchema.parse(raw);
    try {
      validatePackageSigningPublicKey(input.package_signing_public_key);
    } catch (error) {
      throw validationError(error instanceof Error ? error.message : "Adapter package署名鍵を検証できません");
    }
    const duplicate = await this.deps.db.run(scopeOf(actor), (tx) => tx.connections.findFirst({
      where: { organization_id: actor.organizationId, OR: [{ name: input.name }, { metadata: { path: ["repository_id"], equals: input.repository_id } }] },
      select: { id: true },
    }));
    if (duplicate) throw conflict("同じ名前またはrepositoryのGitHub App Connectionがあります");
    const id = randomUUID();
    const metadata = {
      provider: "github_app" as const,
      app_id: input.app_id,
      installation_id: input.installation_id,
      repository_id: input.repository_id,
      owner: input.owner,
      repository: input.repository,
      base_branch: input.base_branch,
      repository_url: `https://github.com/${input.owner}/${input.repository}.git`,
      package_signing_public_key: input.package_signing_public_key,
      permissions: input.permissions,
    };
    const secret: GitHubAppSecret = { private_key: input.private_key, webhook_secret: input.webhook_secret };
    const repository = await this.deps.gitProvider.validateRepository(metadata, secret);
    metadata.base_branch = repository.default_branch;
    const locator = await this.deps.secrets.put(
      secretNames.connection(this.deps.env.SECRETS_PREFIX, actor.organizationId, id),
      JSON.stringify(secret),
      { "agentstudio:organization_id": actor.organizationId, "agentstudio:provider": "github_app" },
    );
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const connection = await tx.connections.create({
        data: {
          id,
          organization_id: actor.organizationId,
          name: input.name,
          description: `GitHub App: ${input.owner}/${input.repository}`,
          scope: "studio",
          secret_locator: locator,
          status: "connected",
          last_validated_at: new Date(),
          metadata,
        },
      });
      await recordAudit(tx, auditBy(actor, {
        action: "connection.github_app.create",
        targetType: "connection",
        targetId: id,
        detail: { provider: "github_app", repository_id: input.repository_id, repository: `${input.owner}/${input.repository}`, permissions: input.permissions },
      }));
      return toConnectionDto(connection);
    });
  }

  /** 接続済みGitHub Appを使い、会社ごとのprivate Integration Repositoryを入力なしで用意する。 */
  async provisionOrganizationIntegrationRepository(actor: MemberActor, sourceConnectionId: string): Promise<ConnectionDto> {
    requireRole(actor, "admin");
    const source = await this.deps.db.run(scopeOf(actor), (tx) => tx.connections.findFirst({
      where: { id: sourceConnectionId, organization_id: actor.organizationId, status: "connected", revoked_at: null },
    }));
    if (!source?.secret_locator) throw notFound("GitHub App Connection");
    let sourceMetadata;
    try {
      sourceMetadata = parseGitHubAppMetadata(source.metadata);
    } catch {
      throw validationError("指定したConnectionはGitHub Appではありません");
    }
    const organization = await this.deps.db.run(scopeOf(actor), (tx) => tx.organizations.findFirst({
      where: { id: actor.organizationId },
      select: { slug: true, name: true },
    }));
    if (!organization) throw notFound("組織");
    const existing = await this.deps.db.run(scopeOf(actor), (tx) => tx.connections.findFirst({
      where: {
        organization_id: actor.organizationId,
        status: "connected",
        revoked_at: null,
        metadata: { path: ["repository_purpose"], equals: "organization_integrations" },
      },
    }));
    if (existing) return toConnectionDto(existing);
    const stored = await this.deps.secrets.get(source.secret_locator);
    if (!stored) throw preconditionFailed("GitHub Appの秘密鍵が見つかりません");
    const secret = parseGitHubAppSecret(stored);
    const repositoryName = `agent-studio-${organization.slug}-tools`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 100);
    let repository;
    try {
      repository = await this.deps.gitProvider.provisionOrganizationRepository({
        metadata: sourceMetadata,
        secret,
        name: repositoryName,
        description: `${organization.name}専用のAgent Studio Runtime Tool`,
      });
    } catch (error) {
      throw preconditionFailed(error instanceof Error ? error.message.replace(/^GitHub App request failed:\s*/i, "") : "企業専用Repositoryを作成できませんでした");
    }
    const [, repositorySlug] = repository.full_name.split("/");
    if (!repositorySlug) throw preconditionFailed("作成したRepository名を確認できませんでした");
    const id = randomUUID();
    const metadata = {
      ...sourceMetadata,
      repository_id: String(repository.id),
      repository: repositorySlug,
      base_branch: repository.default_branch,
      repository_url: `https://github.com/${sourceMetadata.owner}/${repositorySlug}.git`,
      repository_purpose: "organization_integrations" as const,
    };
    const locator = await this.deps.secrets.put(
      secretNames.connection(this.deps.env.SECRETS_PREFIX, actor.organizationId, id),
      JSON.stringify(secret),
      { "agentstudio:organization_id": actor.organizationId, "agentstudio:provider": "github_app" },
    );
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const connection = await tx.connections.create({
        data: {
          id,
          organization_id: actor.organizationId,
          name: `${organization.name} Integration Repository`,
          description: `GitHub App: ${sourceMetadata.owner}/${repositorySlug}`,
          scope: "studio",
          secret_locator: locator,
          status: "connected",
          last_validated_at: new Date(),
          metadata,
        },
      });
      await recordAudit(tx, auditBy(actor, {
        action: "connection.github_app.repository.provision",
        targetType: "connection",
        targetId: id,
        detail: { source_connection_id: sourceConnectionId, repository_id: String(repository.id), repository: repository.full_name, private: true },
      }));
      return toConnectionDto(connection);
    });
  }

  /** 認証情報の値を設定する。値は DB に保存しない（CONN-02） */
  async setConnectionSecret(actor: MemberActor, id: string, input: SetConnectionSecretInput): Promise<void> {
    requireRole(actor, "admin");
    const conn = await this.deps.db.run(scopeOf(actor), (tx) =>
      tx.connections.findFirst({ where: { id, organization_id: actor.organizationId } }),
    );
    if (!conn) throw notFound("接続先");
    if (conn.metadata && typeof conn.metadata === "object" && !Array.isArray(conn.metadata) && (conn.metadata as Record<string, unknown>).provider === "github_app") {
      throw validationError("GitHub Appの秘密情報は専用の接続画面から検証して登録してください");
    }

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
    if (conn.scope !== "studio" || !conn.connector || !["http_openapi", "internal_http_api"].includes(conn.connector.adapter)) {
      if (!conn.secret_locator && conn.scope !== "runtime") throw preconditionFailed("認証情報が設定されていません");
      return this.updateConnectionStatus(actor, conn.id, "connected", "connection.validate", { mode: "configuration" });
    }
    if (conn.connector.auth_type !== "none" && !conn.secret_locator) throw preconditionFailed("認証情報が設定されていません");

    const check = conn.connector.tools.find((tool) => {
      if (tool.risk !== "read") return false;
      const spec = tool.versions[0]?.spec as { studio_function?: { handler?: string; method?: string; base_url?: string; path?: string } } | undefined;
      const fn = spec?.studio_function;
      return fn?.handler === "http_api" && fn.method === "GET" && Boolean(fn.base_url && fn.path) && !fn.path!.includes("{");
    });
    // 自動確認に使える読み取り操作が無い連携は、設定完了として扱う（実際の疎通は Preview の Smoke で確認する）
    if (!check) return this.updateConnectionStatus(actor, conn.id, "connected", "connection.validate", { mode: "configuration", reason: "no_probe_operation" });
    const spec = check.versions[0]!.spec as unknown as { studio_function: { base_url: string; path: string } };
    const url = await assertPublicUrl(`${spec.studio_function.base_url}${spec.studio_function.path}`);
    const headers: Record<string, string> = { accept: "application/json", "user-agent": "agent-studio-connection-check" };
    if (conn.connector.auth_type !== "none") {
      const secret = await this.deps.secrets.get(conn.secret_locator!);
      if (!secret) throw preconditionFailed("認証情報を読み込めませんでした。もう一度設定してください");
      const header = (conn.header_name ?? "Authorization").toLowerCase();
      headers[header] = header === "authorization" && !/^\S+\s/.test(secret) ? `Bearer ${secret}` : secret;
    }
    let status: ConnectionDto["status"] = "error";
    let httpStatus: number | null = null;
    try {
      const response = await fetch(url, {
        method: "GET",
        headers,
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
