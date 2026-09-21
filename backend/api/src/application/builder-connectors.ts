import type {
  ApplyBuilderMcpResultDto,
  ApplyBuilderOpenApiResultDto,
  BuilderMcpInput,
  BuilderMcpProposalDto,
  BuilderOpenApiInput,
  BuilderOpenApiProposalDto,
  ConnectorDto,
  ToolRisk,
} from "@agent-studio/contracts";
import type { Prisma } from "@prisma/client";
import { parse } from "yaml";
import { conflict, notFound } from "../domain/errors.js";
import { inspectOpenApi } from "../domain/openapi-connector.js";
import { inspectMcpDiscovery } from "../domain/mcp-connector.js";
import { recordAudit } from "../infrastructure/audit.js";
import { assertPublicUrl } from "../infrastructure/http/public-url.js";
import { auditBy, requireRole, scopeOf, type MemberActor } from "./context.js";
import type { Deps } from "./deps.js";
import { BuilderProjectService } from "./builder-projects.js";
import { ToolService } from "./tools.js";

const RISK_RANK: Record<ToolRisk, number> = { read: 0, write: 1, external_send: 2, financial: 3, destructive: 4 };
const MAX_OPENAPI_BYTES = 2 * 1024 * 1024;

type ApplyOptions = { requireIdle?: boolean; resume?: boolean };

function highestRisk(risks: ToolRisk[]): ToolRisk {
  return risks.reduce((highest, risk) => (RISK_RANK[risk] > RISK_RANK[highest] ? risk : highest), "read");
}

export class BuilderConnectorService {
  private readonly tools: ToolService;
  private readonly projects: BuilderProjectService;

  constructor(private readonly deps: Deps) {
    this.tools = new ToolService(deps);
    this.projects = new BuilderProjectService(deps);
  }

  async inspectOpenApi(actor: MemberActor, projectId: string, input: BuilderOpenApiInput): Promise<BuilderOpenApiProposalDto> {
    requireRole(actor, "builder");
    await this.assertProject(actor, projectId);
    return inspectOpenApi(input);
  }

  async applyOpenApi(actor: MemberActor, projectId: string, input: BuilderOpenApiInput, options: ApplyOptions = {}): Promise<ApplyBuilderOpenApiResultDto> {
    requireRole(actor, "builder");
    await this.assertProject(actor, projectId, options.requireIdle ?? true);
    const proposal = inspectOpenApi(input);
    const selected = proposal.operations.filter((operation) => operation.selected);
    const connector = await this.tools.createConnector(actor, {
      ...proposal.connector,
      operations: selected.map(({ operation_id: _operationId, selected: _selected, ...operation }) => operation),
    });

    await this.recordGeneration(actor, projectId, proposal, connector);
    if (!proposal.authentication.requires_human_action) {
      const smokePassed = await this.runPublicReadSmoke(actor, projectId, proposal, connector);
      if (!smokePassed) {
        await this.deps.db.run(scopeOf(actor), (tx) =>
          tx.builder_projects.update({ where: { id: projectId }, data: { status: "blocked" } }),
        );
      } else if (options.resume !== false) await this.projects.resume(actor, projectId);
    }
    return { project: await this.projects.get(actor, projectId), connector };
  }

  async inspectMcp(actor: MemberActor, projectId: string, input: BuilderMcpInput): Promise<BuilderMcpProposalDto> {
    requireRole(actor, "builder");
    await this.assertProject(actor, projectId);
    return inspectMcpDiscovery(input, await this.deps.mcpDiscovery(input.server_url));
  }

  async applyMcp(actor: MemberActor, projectId: string, input: BuilderMcpInput, options: ApplyOptions = {}): Promise<ApplyBuilderMcpResultDto> {
    requireRole(actor, "builder");
    await this.assertProject(actor, projectId, options.requireIdle ?? true);
    const proposal = inspectMcpDiscovery(input, await this.deps.mcpDiscovery(input.server_url));
    if (input.expected_content_hash && input.expected_content_hash !== proposal.source.content_hash) {
      throw conflict("MCPサーバーの操作定義が検査後に変わりました。もう一度検査してください");
    }
    const selected = proposal.operations.filter((operation) => operation.selected);
    const connector = await this.tools.createConnector(actor, {
      ...proposal.connector,
      operations: selected.map(({ remote_name: _remoteName, selected: _selected, read_only: _readOnly, destructive: _destructive, ...operation }) => operation),
    });
    await this.recordMcpGeneration(actor, projectId, proposal, connector);
    if (!proposal.authentication.requires_human_action && options.resume !== false) await this.projects.resume(actor, projectId);
    return { project: await this.projects.get(actor, projectId), connector };
  }

  /** Human Actionで指定された公開HTTPSの仕様を、Control Planeへ永続化せずに取得する。 */
  async fetchOpenApiDocument(sourceUrl: string): Promise<Record<string, unknown>> {
    const url = await assertPublicUrl(sourceUrl);
    const response = await fetch(url, {
      headers: { accept: "application/json, application/yaml, text/yaml, text/plain", "user-agent": "agent-studio-builder-discovery" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw conflict(`OpenAPI仕様を取得できませんでした（HTTP ${response.status}）`);
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_OPENAPI_BYTES) throw conflict("OpenAPI仕様が2MBを超えています");
    const source = await response.text();
    if (Buffer.byteLength(source, "utf8") > MAX_OPENAPI_BYTES) throw conflict("OpenAPI仕様が2MBを超えています");
    let parsed: unknown;
    try {
      parsed = parse(source, { maxAliasCount: 20 });
    } catch {
      throw conflict("取得したOpenAPI仕様をJSON/YAMLとして読み取れませんでした");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw conflict("取得したOpenAPI仕様がオブジェクトではありません");
    return parsed as Record<string, unknown>;
  }

  private async runPublicReadSmoke(
    actor: MemberActor,
    projectId: string,
    proposal: BuilderOpenApiProposalDto,
    connector: ConnectorDto,
  ): Promise<boolean> {
    const operation = proposal.operations.find(
      (candidate) => candidate.selected && candidate.risk === "read" && candidate.method === "GET" && !candidate.path.includes("{"),
    );
    if (!operation) return false;
    let status: "passed" | "failed" = "failed";
    let httpStatus: number | null = null;
    let error: string | null = null;
    try {
      const url = await assertPublicUrl(`${proposal.connector.base_url}${operation.path}`);
      const response = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json", "user-agent": "agent-studio-builder-smoke" },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      httpStatus = response.status;
      status = response.ok ? "passed" : "failed";
      if (!response.ok) error = `読取Smoke TestがHTTP ${response.status}を返しました`;
      await response.body?.cancel();
    } catch (cause) {
      error = cause instanceof Error ? cause.message.slice(0, 500) : "読取Smoke Testに失敗しました";
    }
    await this.deps.db.run(scopeOf(actor), async (tx) => {
      await tx.builder_validation_runs.create({
        data: {
          organization_id: actor.organizationId,
          project_id: projectId,
          suite: "smoke",
          environment: "preview",
          status,
          evidence: { connector_id: connector.id, tool: operation.name, method: operation.method, path: operation.path, http_status: httpStatus },
          error_class: status === "passed" ? null : httpStatus ? "provider" : "network",
          error,
          finished_at: new Date(),
        },
      });
      await recordAudit(
        tx,
        auditBy(actor, {
          action: "builder.connector.smoke_test",
          targetType: "connector",
          targetId: connector.id,
          result: status === "passed" ? "success" : "failure",
          detail: { project_id: projectId, tool: operation.name, http_status: httpStatus },
        }),
      );
    });
    return status === "passed";
  }

  private async assertProject(actor: MemberActor, projectId: string, requireIdle = false): Promise<void> {
    const exists = await this.deps.db.run(scopeOf(actor), (tx) =>
      tx.builder_projects.findFirst({
        where: { id: projectId, organization_id: actor.organizationId },
        select: { id: true, runs: { where: { status: { in: ["queued", "running"] } }, take: 1, select: { id: true } } },
      }),
    );
    if (!exists) throw notFound("作成プロジェクト");
    if (requireIdle && exists.runs.length > 0) throw conflict("計画処理の完了後に連携サービスを反映してください");
  }

  private async recordMcpGeneration(
    actor: MemberActor,
    projectId: string,
    proposal: BuilderMcpProposalDto,
    connector: ConnectorDto,
  ): Promise<void> {
    const selected = proposal.operations.filter((operation) => operation.selected);
    const risk = highestRisk(selected.map((operation) => operation.risk));
    const artifacts = [
      { type: "connector", id: connector.id, name: connector.name },
      ...connector.tools.map((tool) => ({ type: "tool", id: tool.id, name: tool.name, version: tool.latest_version })),
    ];
    await this.deps.db.run(scopeOf(actor), async (tx) => {
      await tx.builder_discovery_sources.create({
        data: {
          organization_id: actor.organizationId,
          project_id: projectId,
          kind: "mcp",
          title: proposal.source.title,
          spec_version: proposal.source.spec_version,
          source_url: proposal.source.source_url,
          content_hash: proposal.source.content_hash,
          metadata: {
            server_origin: new URL(proposal.connector.base_url).origin,
            tool_count: proposal.operations.length,
            selected_tool_count: selected.length,
            authentication_kind: proposal.authentication.kind,
            annotation_summary: {
              read_only: proposal.operations.filter((operation) => operation.read_only === true).length,
              write_or_unknown: proposal.operations.filter((operation) => operation.read_only !== true && !operation.destructive).length,
              destructive: proposal.operations.filter((operation) => operation.destructive).length,
            },
            warnings: proposal.warnings,
          } as Prisma.InputJsonValue,
        },
      });
      await tx.builder_change_sets.create({
        data: {
          organization_id: actor.organizationId,
          project_id: projectId,
          kind: "declarative_connector",
          status: "applied",
          summary: `${connector.name} と ${connector.tools.length}件のMCP操作を生成`,
          risk,
          artifacts: artifacts as Prisma.InputJsonValue,
          source_hash: proposal.source.content_hash,
        },
      });
      await tx.builder_validation_runs.createMany({ data: [
        {
          organization_id: actor.organizationId,
          project_id: projectId,
          suite: "contract",
          environment: "builder",
          status: "passed",
          evidence: {
            protocol: "MCP",
            connector_id: connector.id,
            tool_versions: connector.tools.map((tool) => ({ tool_id: tool.id, version: tool.latest_version })),
            operation_count: selected.length,
            source_hash: proposal.source.content_hash,
          },
          finished_at: new Date(),
        },
        {
          organization_id: actor.organizationId,
          project_id: projectId,
          suite: "security",
          environment: "builder",
          status: "passed",
          evidence: { checks: ["https_server_url", "private_literal_blocked", "deterministic_risk", "remote_tool_allowlist", "secret_not_persisted"] },
          finished_at: new Date(),
        },
        {
          organization_id: actor.organizationId,
          project_id: projectId,
          suite: "smoke",
          environment: "preview",
          status: proposal.authentication.requires_human_action ? "blocked" : "passed",
          evidence: {
            connector_id: connector.id,
            check: "mcp.tools/list",
            discovered_tools: proposal.operations.map((operation) => operation.remote_name),
            source_hash: proposal.source.content_hash,
          },
          error_class: proposal.authentication.requires_human_action ? "auth" : null,
          error: proposal.authentication.requires_human_action ? "Preview用Connectionの接続テスト完了後に自動再開します" : null,
          finished_at: new Date(),
        },
      ] });
      if (proposal.authentication.requires_human_action) {
        await tx.human_actions.create({ data: {
          organization_id: actor.organizationId,
          project_id: projectId,
          type: "enter_secret",
          title: `${connector.name}のBearer接続を設定`,
          reason: `${connector.name}のMCP操作をPreviewで検証するために認証が必要です`,
          assignee_role: "admin",
          fields: [],
          instructions: ["接続済みアカウント画面を開きます", "このMCP連携用のPreview接続を作成します", "Tokenは専用入力欄から保存し、接続テストを実行します"],
          resume_condition: { type: "connection_status", connector_id: connector.id, stage: "staging", status: "connected" },
        } });
        await tx.builder_projects.update({ where: { id: projectId }, data: { status: "waiting_human_action" } });
      } else {
        await tx.builder_projects.update({ where: { id: projectId }, data: { status: "implementing" } });
      }
      await recordAudit(tx, auditBy(actor, {
        action: "builder.mcp.apply",
        targetType: "builder_project",
        targetId: projectId,
        detail: { connector_id: connector.id, source_hash: proposal.source.content_hash, operation_count: selected.length, risk, authentication_kind: proposal.authentication.kind },
      }));
    });
  }

  private async recordGeneration(
    actor: MemberActor,
    projectId: string,
    proposal: BuilderOpenApiProposalDto,
    connector: ConnectorDto,
  ): Promise<void> {
    const selected = proposal.operations.filter((operation) => operation.selected);
    const risk = highestRisk(selected.map((operation) => operation.risk));
    const artifacts = [
      { type: "connector", id: connector.id, name: connector.name },
      ...connector.tools.map((tool) => ({ type: "tool", id: tool.id, name: tool.name, version: tool.latest_version })),
    ];
    await this.deps.db.run(scopeOf(actor), async (tx) => {
      await tx.builder_discovery_sources.create({
        data: {
          organization_id: actor.organizationId,
          project_id: projectId,
          kind: "openapi",
          title: proposal.source.title,
          spec_version: proposal.source.spec_version,
          source_url: proposal.source.source_url,
          content_hash: proposal.source.content_hash,
          metadata: {
            base_url_origin: new URL(proposal.connector.base_url).origin,
            operation_count: proposal.operations.length,
            selected_operation_count: selected.length,
            authentication_kind: proposal.authentication.kind,
            warnings: proposal.warnings,
          } as Prisma.InputJsonValue,
        },
      });
      await tx.builder_change_sets.create({
        data: {
          organization_id: actor.organizationId,
          project_id: projectId,
          kind: "declarative_connector",
          status: "applied",
          summary: `${connector.name} と ${connector.tools.length}件の操作を生成`,
          risk,
          artifacts: artifacts as Prisma.InputJsonValue,
          source_hash: proposal.source.content_hash,
        },
      });
      await tx.builder_validation_runs.createMany({
        data: [
          {
            organization_id: actor.organizationId,
            project_id: projectId,
            suite: "contract",
            environment: "builder",
            status: "passed",
            evidence: {
              openapi_version: proposal.source.spec_version,
              connector_id: connector.id,
              tool_versions: connector.tools.map((tool) => ({ tool_id: tool.id, version: tool.latest_version })),
              operation_count: selected.length,
            },
            finished_at: new Date(),
          },
          {
            organization_id: actor.organizationId,
            project_id: projectId,
            suite: "security",
            environment: "builder",
            status: "passed",
            evidence: {
              checks: ["https_base_url", "private_literal_blocked", "external_refs_blocked", "deterministic_risk", "secret_not_persisted"],
            },
            finished_at: new Date(),
          },
          {
            organization_id: actor.organizationId,
            project_id: projectId,
            suite: "smoke",
            environment: "preview",
            status: "blocked",
            evidence: {
              connector_id: connector.id,
              reason: proposal.authentication.requires_human_action ? "connection_required" : "preview_agent_required",
              read_operations: selected.filter((operation) => operation.risk === "read").map((operation) => operation.name),
            },
            error_class: proposal.authentication.requires_human_action ? "auth" : "requirement",
            error: proposal.authentication.requires_human_action
              ? "Preview用Connectionの接続テスト完了後に自動再開します"
              : "Preview Agentの生成後に読取Smoke Testを実行します",
            finished_at: new Date(),
          },
        ],
      });

      if (proposal.authentication.requires_human_action) {
        const oauth = proposal.authentication.kind === "oauth2";
        await tx.human_actions.create({
          data: {
            organization_id: actor.organizationId,
            project_id: projectId,
            type: oauth ? "provider_app_registration" : "enter_secret",
            title: oauth ? `${connector.name}のOAuth接続を準備` : `${connector.name}の接続情報を設定`,
            reason: `${connector.name}のAPIをPreviewで検証するために認証が必要です`,
            assignee_role: "admin",
            fields: [],
            instructions: oauth
              ? ["Providerの管理画面でOAuth Appを登録します", "Callback URLと必要Scopeを確認します", "連携サービス画面からOAuth接続を完了します"]
              : ["接続済みアカウント画面を開きます", "この連携サービス用のPreview接続を作成します", "Secretは専用入力欄から保存し、接続テストを実行します"],
            resume_condition: {
              type: "connection_status",
              connector_id: connector.id,
              stage: "staging",
              status: "connected",
              ...(proposal.authentication.header_name ? { header_name: proposal.authentication.header_name } : {}),
              ...(proposal.authentication.scopes.length > 0 ? { scopes: proposal.authentication.scopes } : {}),
            },
          },
        });
        await tx.builder_projects.update({ where: { id: projectId }, data: { status: "waiting_human_action" } });
      } else {
        await tx.builder_projects.update({ where: { id: projectId }, data: { status: "implementing" } });
      }
      await recordAudit(
        tx,
        auditBy(actor, {
          action: "builder.openapi.apply",
          targetType: "builder_project",
          targetId: projectId,
          detail: {
            connector_id: connector.id,
            source_hash: proposal.source.content_hash,
            operation_count: selected.length,
            risk,
            authentication_kind: proposal.authentication.kind,
          },
        }),
      );
    });
  }
}
