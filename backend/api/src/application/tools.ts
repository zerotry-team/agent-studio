import type { Prisma } from "@prisma/client";
import {
  createToolInputSchema,
  toolVersionSpecSchema,
  type ConnectionDto,
  type CreateConnectionInput,
  type CreateToolInput,
  type CreateToolVersionInput,
  type SetConnectionSecretInput,
  type ToolDto,
  type ToolVersionDto,
} from "@agent-studio/contracts";
import { conflict, notFound, preconditionFailed, validationError } from "../domain/errors.js";
import { recordAudit } from "../infrastructure/audit.js";
import { secretNames } from "../infrastructure/secrets/secret-store.js";
import { auditBy, requireRole, scopeOf, type MemberActor } from "./context.js";
import type { Deps } from "./deps.js";
import { toConnectionDto, toToolDto, toToolVersionDto } from "./dto.js";

export class ToolService {
  constructor(private readonly deps: Deps) {}

  async list(actor: MemberActor): Promise<ToolDto[]> {
    return this.deps.db.run(scopeOf(actor), async (tx) =>
      (await tx.tools.findMany({ where: { organization_id: actor.organizationId }, orderBy: { name: "asc" } })).map((t) => toToolDto(t)),
    );
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
        ? spec.studio_function.connection_id
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
      if (input.scope === "runtime") {
        const runtime = await tx.runtimes.findFirst({ where: { id: input.runtime_id!, organization_id: actor.organizationId } });
        if (!runtime) throw validationError("指定した Runtime が見つかりません");
      }
      const dup = await tx.connections.findUnique({ where: { organization_id_name: { organization_id: actor.organizationId, name: input.name } } });
      if (dup) throw conflict("同じ名前の接続先があります");
      const c = await tx.connections.create({
        data: {
          organization_id: actor.organizationId,
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
      await tx.connections.update({ where: { id }, data: { secret_locator: locator } });
      await recordAudit(tx, auditBy(actor, { action: "connection.secret.set", targetType: "connection", targetId: id, detail: { scope: conn.scope } }));
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
