import { Prisma } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import type {
  ApprovalRequest,
  ApprovalResponse,
  ApprovalStatus,
  HeartbeatRequest,
  JobResultRequest,
  Policy,
  RegisterRequest,
  RegisterResponse,
  RuntimeJob,
  SessionArtifactRequest,
  SessionArtifactResponse,
  SessionEventRequest,
  SessionGrant,
  TokenRequest,
  TokenResponse,
  ToolAuditEvent,
  ToolVersionSpec,
  GitCredentialResponse,
} from "@agent-studio/contracts";
import { adapterDescriptorSchema, browserLoginResultSchema, builderWorkspaceResultSchema, canonicalJson, gitPublishResultSchema, type RuntimeBrowserProfile } from "@agent-studio/contracts";
import { inspectArtifact } from "../domain/artifact-security.js";
import { AppError, notFound } from "../domain/errors.js";
import { evaluateOrganizationAutoApproval } from "../domain/organization-auto-approval.js";
import { recordAudit } from "../infrastructure/audit.js";
import { artifactPrefix } from "../infrastructure/storage/object-store.js";
import type { Tx } from "../infrastructure/db/tenant-db.js";
import type { Deps } from "./deps.js";
import { hashToken } from "./environments.js";
import { appendRunEvent } from "./run-events.js";
import { parseGitHubAppMetadata, parseGitHubAppSecret } from "../infrastructure/git/github-app.js";
import { BuilderGitAutomationService } from "./builder-git-automation.js";

export interface RuntimeContext {
  runtimeId: string;
  organizationId: string;
  sourceIp: string | null;
}

/** ジョブを取り出してから結果が返るまでの猶予（start_session は Worker の起動を待つため長め） */
const JOB_LEASE_SECONDS = 35 * 60;
const LONG_POLL_INTERVAL_MS = 1000;

const notRegistered = () =>
  new AppError("runtime_not_registered", 403, "この Runtime はまだ登録されていません。登録用トークンで登録してください");
const revoked = () => new AppError("runtime_revoked", 403, "この Runtime は無効にされています");

/**
 * Runtime Controller からの API（Execution Plane → Control Plane）。
 * Runtime の身元は、署名済み GetCallerIdentity で確認した AWS アカウント ID + IAM ロール名で決まる（SEC-05）。
 * 組織は自己申告させない。
 */
export class RuntimeApiService {
  private readonly gitAutomation: BuilderGitAutomationService;

  constructor(private readonly deps: Deps) {
    this.gitAutomation = new BuilderGitAutomationService(deps);
  }

  /** 初回登録（RTM-03）。Bootstrap Token と AWS の身元の両方が一致した場合だけ成功する */
  async register(req: RegisterRequest, sourceIp: string | null): Promise<RegisterResponse> {
    const principal = await this.deps.runtimeIdentity.verify(req.identity);
    const consumed = await this.deps.system.consumeBootstrapToken(hashToken(req.bootstrap_token), principal.accountId, principal.roleName);

    if (!consumed) {
      await this.deps.db.run({ organizationId: null, userId: null }, (tx) =>
        recordAudit(tx, {
          organizationId: null,
          actorType: "runtime",
          actorLabel: principal.arn,
          action: "runtime.register",
          result: "denied",
          sourceIp,
          detail: { aws_account_id: principal.accountId, role: principal.roleName },
        }),
      );
      throw new AppError("bootstrap_invalid", 403, "登録用トークンが無効か、AWS アカウント・ロールが登録内容と一致しません");
    }

    const environmentKey = await this.environmentKeyOf(consumed.organization_id);
    await this.deps.db.org(consumed.organization_id, async (tx) => {
      await tx.runtimes.update({ where: { id: consumed.runtime_id }, data: { controller_version: req.controller_version } });
      await recordAudit(tx, {
        organizationId: consumed.organization_id,
        actorType: "runtime",
        actorId: consumed.runtime_id,
        actorLabel: principal.arn,
        action: "runtime.register",
        targetType: "runtime",
        targetId: consumed.runtime_id,
        sourceIp,
        detail: { aws_account_id: principal.accountId, role: principal.roleName },
      });
      const actions = await tx.human_actions.findMany({
        where: { organization_id: consumed.organization_id, type: "aws_admin_action", status: "pending" },
        include: { project: true },
      });
      for (const action of actions) {
        const condition = action.resume_condition as { type?: unknown; runtime_id?: unknown };
        if (condition.type !== "runtime_active" || condition.runtime_id !== consumed.runtime_id) continue;
        await tx.human_actions.update({ where: { id: action.id }, data: { status: "completed", completed_at: new Date() } });
        await tx.builder_validation_runs.create({ data: {
          organization_id: consumed.organization_id,
          project_id: action.project_id,
          suite: "smoke",
          environment: consumed.stage === "production" ? "production" : "preview",
          status: "passed",
          evidence: { runtime_id: consumed.runtime_id, registered: true, controller_version: req.controller_version, identity_verified: true },
          finished_at: new Date(),
        } });
        const remaining = await tx.human_actions.count({ where: { project_id: action.project_id, status: "pending" } });
        const active = await tx.builder_runs.count({ where: { project_id: action.project_id, status: { in: ["queued", "running"] } } });
        if (remaining === 0 && active === 0) {
          const last = await tx.builder_runs.aggregate({ where: { project_id: action.project_id }, _max: { attempt: true } });
          const hash = (value: string) => createHash("sha256").update(value).digest("hex");
          await tx.builder_runs.create({ data: {
            organization_id: consumed.organization_id,
            project_id: action.project_id,
            attempt: (last._max.attempt ?? 0) + 1,
            correlation_id: randomUUID(),
            budget: { max_attempts: 3, phase: "planning" },
            steps: { create: [
              { kind: "analyze_requirements", input_hash: hash(action.project.request) },
              { kind: "resolve_capabilities", input_hash: hash(`${action.project.request}:resolve`) },
              { kind: "prepare_human_actions", input_hash: hash(`${action.project.request}:human`) },
            ] },
          } });
          await tx.builder_projects.update({ where: { id: action.project_id }, data: { status: "draft" } });
        }
        await recordAudit(tx, {
          organizationId: consumed.organization_id,
          actorType: "runtime",
          actorId: consumed.runtime_id,
          action: "builder.human_action.auto_complete",
          targetType: "human_action",
          targetId: action.id,
          detail: { project_id: action.project_id, runtime_id: consumed.runtime_id },
        });
      }
    });

    const { token, expiresIn } = await this.deps.runtimeTokens.issue({
      runtimeId: consumed.runtime_id,
      organizationId: consumed.organization_id,
    });
    return {
      runtime_id: consumed.runtime_id,
      organization_id: consumed.organization_id,
      stage: consumed.stage as RegisterResponse["stage"],
      access_token: token,
      expires_in: expiresIn,
      environment_key: environmentKey,
    };
  }

  /** 短期トークンの発行（RTM-04） */
  async token(req: TokenRequest): Promise<TokenResponse> {
    const principal = await this.deps.runtimeIdentity.verify(req.identity);
    const runtime = await this.deps.system.resolveRuntimePrincipal(principal.accountId, principal.roleName);
    if (!runtime || runtime.status === "pending" || runtime.status === "provisioning") throw notRegistered();
    if (runtime.status === "revoked") throw revoked();
    const { token, expiresIn } = await this.deps.runtimeTokens.issue({
      runtimeId: runtime.runtime_id,
      organizationId: runtime.organization_id,
    });
    return { runtime_id: runtime.runtime_id, organization_id: runtime.organization_id, access_token: token, expires_in: expiresIn };
  }

  /** アクセストークンを検証し、Runtime が無効にされていないかを毎回確認する */
  async authenticate(accessToken: string, sourceIp: string | null): Promise<RuntimeContext> {
    const claims = await this.deps.runtimeTokens.verify(accessToken);
    const runtime = await this.deps.db.org(claims.organizationId, (tx) =>
      tx.runtimes.findFirst({ where: { id: claims.runtimeId, organization_id: claims.organizationId } }),
    );
    if (!runtime) throw notRegistered();
    if (runtime.status === "revoked") throw revoked();
    return { runtimeId: runtime.id, organizationId: runtime.organization_id, sourceIp };
  }

  async heartbeat(ctx: RuntimeContext, req: HeartbeatRequest): Promise<{ ok: true; server_time: string }> {
    await this.deps.db.org(ctx.organizationId, async (tx) => {
      const runtime = await tx.runtimes.findUniqueOrThrow({ where: { id: ctx.runtimeId } });
      const connector = await tx.connectors.upsert({
        where: { organization_id_key: { organization_id: ctx.organizationId, key: `runtime-${ctx.runtimeId}` } },
        create: {
          organization_id: ctx.organizationId,
          key: `runtime-${ctx.runtimeId}`,
          name: `${runtime.name} Tool Catalog`,
          description: "署名済みRuntime heartbeatから同期した、顧客実行環境内の操作です",
          adapter: "runtime",
          auth_type: "runtime_secret",
        },
        update: { name: `${runtime.name} Tool Catalog` },
      });
      await tx.connections.upsert({
        where: { organization_id_name: { organization_id: ctx.organizationId, name: `runtime-${ctx.runtimeId}` } },
        create: {
          organization_id: ctx.organizationId,
          connector_id: connector.id,
          name: `runtime-${ctx.runtimeId}`,
          description: "Runtime Controllerが管理する顧客AWS内のSecret参照",
          scope: "runtime",
          runtime_id: ctx.runtimeId,
          runtime_secret_name: "tool-catalog",
          status: "connected",
          last_validated_at: new Date(),
        },
        update: { connector_id: connector.id, runtime_id: ctx.runtimeId, status: "connected", last_validated_at: new Date(), revoked_at: null },
      });
      const acceptedTools: typeof req.tools = [];
      const reportedPackages = new Map<string, { package: NonNullable<Awaited<ReturnType<typeof tx.builder_adapter_packages.findFirst>>>; tools: Set<string> }>();
      for (const entry of req.tools) {
        let targetConnector = connector;
        let matchedPackage: Awaited<ReturnType<typeof tx.builder_adapter_packages.findFirst>> = null;
        if (entry.delivery) {
          matchedPackage = await tx.builder_adapter_packages.findFirst({
            where: {
              runtime_id: ctx.runtimeId,
              connector_key: entry.delivery.connector_key,
              source_commit: entry.delivery.source_commit,
              image_digest: entry.delivery.image_digest,
              contract_hash: entry.delivery.contract_hash,
              signature: entry.delivery.package_signature,
              status: { in: ["deployed", "registered"] },
            },
          });
          if (!matchedPackage) {
            const drifted = await tx.builder_adapter_packages.findFirst({
              where: { runtime_id: ctx.runtimeId, connector_key: entry.delivery.connector_key, status: { in: ["deployed", "registered"] } },
            });
            if (drifted) {
              await tx.builder_adapter_packages.update({ where: { id: drifted.id }, data: { status: "failed", health_status: "failed", error_class: "contract_drift", error: "Runtime heartbeatのsource commit、digest、contract hash、signatureが期待値と一致しません" } });
              await tx.builder_validation_runs.create({ data: {
                organization_id: ctx.organizationId, project_id: drifted.project_id, suite: "tool_catalog", environment: "preview", status: "failed",
                evidence: { package_id: drifted.id, connector_key: entry.delivery.connector_key, expected_contract_hash: drifted.contract_hash, actual_contract_hash: entry.delivery.contract_hash, expected_image_digest: drifted.image_digest, actual_image_digest: entry.delivery.image_digest },
                error_class: "contract_drift", error: "期待したAdapter packageとheartbeatが一致しません", finished_at: new Date(),
              } });
            }
            continue;
          }
          targetConnector = await tx.connectors.upsert({
            where: { organization_id_key: { organization_id: ctx.organizationId, key: entry.delivery.connector_key } },
            create: {
              organization_id: ctx.organizationId, key: entry.delivery.connector_key, name: entry.delivery.connector_key.replaceAll("-", " "),
              description: "署名付きAdapter packageからRuntime heartbeatで登録された連携サービスです", adapter: "runtime", auth_type: "runtime_secret",
            },
            update: { description: "署名付きAdapter packageからRuntime heartbeatで登録された連携サービスです", adapter: "runtime" },
          });
          await tx.connections.upsert({
            where: { organization_id_name: { organization_id: ctx.organizationId, name: `runtime-${ctx.runtimeId}-${entry.delivery.connector_key}` } },
            create: {
              organization_id: ctx.organizationId, connector_id: targetConnector.id, name: `runtime-${ctx.runtimeId}-${entry.delivery.connector_key}`,
              description: "Preview Runtimeへdigest固定で配布されたAdapterのSecret参照", scope: "runtime", runtime_id: ctx.runtimeId,
              runtime_secret_name: entry.delivery.connector_key, status: "connected", last_validated_at: new Date(),
            },
            update: { connector_id: targetConnector.id, runtime_id: ctx.runtimeId, status: "connected", last_validated_at: new Date(), revoked_at: null },
          });
        }
        const spec = {
          execution_location: "runtime_mcp",
          description: entry.description,
          input_schema: entry.input_schema,
          risk: entry.risk,
          reads_untrusted_content: entry.reads_untrusted_content,
          ...(entry.delivery ? { delivery: entry.delivery } : {}),
        } as unknown as ToolVersionSpec;
        const existing = await tx.tools.findUnique({
          where: { organization_id_name: { organization_id: ctx.organizationId, name: entry.name } },
          include: { versions: { orderBy: { version: "desc" }, take: 1 } },
        });
        if (existing && existing.connector_id !== targetConnector.id) continue;
        if (!existing) {
          await tx.tools.create({ data: {
            organization_id: ctx.organizationId,
            connector_id: targetConnector.id,
            name: entry.name,
            display_name: entry.name.replaceAll("_", " "),
            execution_location: "runtime_mcp",
            risk: entry.risk,
            versions: { create: { version: 1, spec: spec as Prisma.InputJsonValue } },
          } });
        } else if (canonicalJson(existing.versions[0]?.spec ?? null) !== canonicalJson(spec)) {
          const version = existing.latest_version + 1;
          await tx.tool_versions.create({ data: { organization_id: ctx.organizationId, tool_id: existing.id, version, spec: spec as Prisma.InputJsonValue } });
          await tx.tools.update({ where: { id: existing.id }, data: { latest_version: version, risk: entry.risk } });
        }
        acceptedTools.push(entry);
        if (matchedPackage) {
          const reported = reportedPackages.get(matchedPackage.id) ?? { package: matchedPackage, tools: new Set<string>() };
          reported.tools.add(entry.name);
          reportedPackages.set(matchedPackage.id, reported);
        }
      }
      for (const reported of reportedPackages.values()) {
        const provenance = reported.package.provenance && typeof reported.package.provenance === "object" && !Array.isArray(reported.package.provenance)
          ? reported.package.provenance as Record<string, unknown> : {};
        const descriptor = adapterDescriptorSchema.safeParse(provenance.descriptor);
        const expectedTools = descriptor.success ? descriptor.data.tools.map((tool) => tool.name) : [];
        if (!descriptor.success || !expectedTools.every((name) => reported.tools.has(name))) continue;
        const expectedContractHash = createHash("sha256").update(canonicalJson(descriptor.data.tools)).digest("hex");
        if (expectedContractHash !== reported.package.contract_hash) continue;
        // heartbeatは継続的に届く。登録済みpackageで毎回Builder Runを再作成すると、
        // Production成功後にも新しいPreviewが始まって完成状態を壊すため、遷移は一度だけ行う。
        if (reported.package.status === "registered" && reported.package.health_status === "ready") continue;
        await tx.builder_adapter_packages.update({ where: { id: reported.package.id }, data: { status: "registered", health_status: "ready", registered_at: new Date() } });
        await tx.builder_validation_runs.create({ data: {
          organization_id: ctx.organizationId, project_id: reported.package.project_id, suite: "tool_catalog", environment: "preview", status: "passed",
          evidence: { package_id: reported.package.id, connector_key: reported.package.connector_key, tool_names: expectedTools, source_commit: reported.package.source_commit, image_digest: reported.package.image_digest, contract_hash: reported.package.contract_hash, health_status: "ready" }, finished_at: new Date(),
        } });
        const actions = await tx.human_actions.findMany({ where: { project_id: reported.package.project_id, type: "adapter_delivery", status: "pending" } });
        for (const action of actions) {
          const condition = action.resume_condition && typeof action.resume_condition === "object" && !Array.isArray(action.resume_condition) ? action.resume_condition as Record<string, unknown> : {};
          if (condition.change_set_id !== reported.package.change_set_id) continue;
          await tx.human_actions.update({ where: { id: action.id }, data: { status: "completed", completed_at: new Date() } });
        }
        const remaining = await tx.human_actions.count({ where: { project_id: reported.package.project_id, status: "pending" } });
        const active = await tx.builder_runs.count({ where: { project_id: reported.package.project_id, status: { in: ["queued", "running"] } } });
        if (remaining === 0 && active === 0) {
          const project = await tx.builder_projects.findUniqueOrThrow({ where: { id: reported.package.project_id } });
          const last = await tx.builder_runs.aggregate({ where: { project_id: project.id }, _max: { attempt: true } });
          const hash = (value: string) => createHash("sha256").update(value).digest("hex");
          await tx.builder_runs.create({ data: {
            organization_id: ctx.organizationId, project_id: project.id, attempt: (last._max.attempt ?? 0) + 1, correlation_id: randomUUID(),
            budget: { max_attempts: 3, phase: "planning" },
            steps: { create: [
              { kind: "analyze_requirements", input_hash: hash(project.request) },
              { kind: "resolve_capabilities", input_hash: hash(`${project.request}:resolve`) },
              { kind: "prepare_human_actions", input_hash: hash(`${project.request}:human`) },
            ] },
          } });
          await tx.builder_projects.update({ where: { id: project.id }, data: { status: "draft" } });
        }
      }
      await tx.runtimes.update({
        where: { id: ctx.runtimeId },
        data: {
          controller_version: req.controller_version,
          gateway_url: req.gateway_url,
          tool_catalog: acceptedTools as unknown as Prisma.InputJsonValue,
          capabilities: (req.capabilities ?? []) as unknown as Prisma.InputJsonValue,
          last_heartbeat_at: new Date(),
          ...(runtime.status === "offline" || runtime.status === "degraded" ? { status: "active" } : {}),
        },
      });
      const runtimeProfile = await tx.runtime_profiles.findFirst({
        where: { organization_id: ctx.organizationId, runtime_id: ctx.runtimeId, type: "self_hosted" },
        select: { id: true },
      });
      const advertisedTools = new Set(acceptedTools.map((tool) => tool.name));
      const advertisedCapabilities = new Set(req.capabilities ?? []);
      const readinessActions = runtimeProfile ? await tx.human_actions.findMany({
        where: { organization_id: ctx.organizationId, type: "aws_admin_action", status: "pending" },
        include: { project: true },
      }) : [];
      for (const action of readinessActions) {
        const condition = action.resume_condition as { type?: unknown; required_tools?: unknown };
        const requiredTools = Array.isArray(condition.required_tools)
          ? condition.required_tools.filter((name): name is string => typeof name === "string")
          : [];
        const browserReady = condition.type === "browser_runtime_ready" && requiredTools.length > 0;
        const workspaceReady = condition.type === "code_workspace_runtime_ready" && advertisedCapabilities.has("builder_workspace");
        if (!browserReady && !workspaceReady) continue;
        if (browserReady) {
          if (!req.gateway_url || !requiredTools.length || !requiredTools.every((name) => advertisedTools.has(name))) continue;
          const syncedTools = await tx.tools.count({
            where: { organization_id: ctx.organizationId, name: { in: requiredTools }, execution_location: "runtime_mcp" },
          });
          if (syncedTools !== requiredTools.length) continue;
        }
        await tx.human_actions.update({ where: { id: action.id }, data: { status: "completed", completed_at: new Date() } });
        await tx.builder_validation_runs.create({ data: {
          organization_id: ctx.organizationId,
          project_id: action.project_id,
          suite: "smoke",
          environment: "builder",
          status: "passed",
          evidence: browserReady
            ? { runtime_id: ctx.runtimeId, browser_runtime_ready: true, required_tools: requiredTools, gateway_reported: true }
            : { runtime_id: ctx.runtimeId, code_workspace_runtime_ready: true, capability: "builder_workspace" },
          finished_at: new Date(),
        } });
        const remaining = await tx.human_actions.count({ where: { project_id: action.project_id, status: "pending" } });
        const active = await tx.builder_runs.count({ where: { project_id: action.project_id, status: { in: ["queued", "running"] } } });
        if (remaining === 0 && active === 0) {
          const last = await tx.builder_runs.aggregate({ where: { project_id: action.project_id }, _max: { attempt: true } });
          const hash = (value: string) => createHash("sha256").update(value).digest("hex");
          await tx.builder_runs.create({ data: {
            organization_id: ctx.organizationId,
            project_id: action.project_id,
            attempt: (last._max.attempt ?? 0) + 1,
            correlation_id: randomUUID(),
            budget: { max_attempts: 3, phase: "planning" },
            steps: { create: [
              { kind: "analyze_requirements", input_hash: hash(action.project.request) },
              { kind: "resolve_capabilities", input_hash: hash(`${action.project.request}:resolve`) },
              { kind: "prepare_human_actions", input_hash: hash(`${action.project.request}:human`) },
            ] },
          } });
          await tx.builder_projects.update({ where: { id: action.project_id }, data: { status: "draft" } });
        }
        await recordAudit(tx, {
          organizationId: ctx.organizationId,
          actorType: "runtime",
          actorId: ctx.runtimeId,
          action: "builder.human_action.auto_complete",
          targetType: "human_action",
          targetId: action.id,
          sourceIp: ctx.sourceIp,
          detail: { project_id: action.project_id, runtime_id: ctx.runtimeId, condition: String(condition.type), required_tools: requiredTools },
        });
      }
      if (runtime.status === "offline") {
        await recordAudit(tx, {
          organizationId: ctx.organizationId,
          actorType: "runtime",
          actorId: ctx.runtimeId,
          action: "runtime.online",
          targetType: "runtime",
          targetId: ctx.runtimeId,
          sourceIp: ctx.sourceIp,
        });
      }
      await recordAudit(tx, {
        organizationId: ctx.organizationId,
        actorType: "runtime",
        actorId: ctx.runtimeId,
        action: "runtime.tool_catalog.sync",
        targetType: "connector",
        targetId: connector.id,
        sourceIp: ctx.sourceIp,
        detail: { reported_tool_count: req.tools.length, accepted_tool_count: acceptedTools.length },
      });
    });
    return { ok: true, server_time: new Date().toISOString() };
  }

  /** long-poll でジョブを1件取り出す（RTM-05）。自分宛てのジョブしか取れない */
  async nextJob(ctx: RuntimeContext, waitSeconds: number, signal: AbortSignal): Promise<RuntimeJob | null> {
    const deadline = Date.now() + Math.min(Math.max(waitSeconds, 0), 25) * 1000;
    for (;;) {
      const job = await this.deps.db.org(ctx.organizationId, (tx) => this.leaseJob(tx, ctx.runtimeId));
      if (job || Date.now() >= deadline || signal.aborted) return job;
      await new Promise((r) => setTimeout(r, LONG_POLL_INTERVAL_MS));
    }
  }

  /** leased中のbranch push jobへ、repository限定installation tokenを一度だけ返す。 */
  async gitCredential(ctx: RuntimeContext, jobId: string): Promise<GitCredentialResponse> {
    const claimed = await this.deps.db.org(ctx.organizationId, async (tx) => {
      const updated = await tx.runtime_jobs.updateMany({
        where: { id: jobId, runtime_id: ctx.runtimeId, type: "publish_builder_branch", status: "leased", credential_consumed_at: null },
        data: { credential_consumed_at: new Date() },
      });
      if (updated.count !== 1) throw new AppError("git_credential_unavailable", 409, "Git資格情報は利用済みか、このジョブでは利用できません");
      const job = await tx.runtime_jobs.findUniqueOrThrow({ where: { id: jobId } });
      const payload = job.payload && typeof job.payload === "object" && !Array.isArray(job.payload) ? job.payload as Record<string, unknown> : {};
      const connectionId = typeof payload.connection_id === "string" ? payload.connection_id : null;
      const repositoryUrl = typeof payload.repository_url === "string" ? payload.repository_url : null;
      if (!connectionId || !repositoryUrl) throw new AppError("invalid_job", 400, "Git公開ジョブの接続情報がありません");
      const connection = await tx.connections.findFirst({ where: { id: connectionId, organization_id: ctx.organizationId, status: "connected" } });
      if (!connection?.secret_locator) throw new AppError("git_connection_unavailable", 412, "GitHub App Connectionが利用できません");
      const metadata = parseGitHubAppMetadata(connection.metadata);
      if (metadata.repository_url !== repositoryUrl) throw new AppError("repository_not_allowed", 403, "GitHub App Connectionのrepository allowlist外です");
      return { connection, metadata, repositoryUrl };
    });
    try {
      const stored = await this.deps.secrets.get(claimed.connection.secret_locator!);
      if (!stored) throw new AppError("git_connection_unavailable", 412, "GitHub Appの秘密鍵が見つかりません");
      const token = await this.deps.gitProvider.createInstallationToken(claimed.metadata, parseGitHubAppSecret(stored));
      await this.deps.db.org(ctx.organizationId, (tx) => recordAudit(tx, {
        organizationId: ctx.organizationId,
        actorType: "runtime",
        actorId: ctx.runtimeId,
        action: "git.credential.consume",
        targetType: "runtime_job",
        targetId: jobId,
        sourceIp: ctx.sourceIp,
        detail: { repository_id: claimed.metadata.repository_id, expires_at: token.expiresAt },
      }));
      return { username: "x-access-token", token: token.token, expires_at: token.expiresAt, repository_url: claimed.repositoryUrl };
    } catch (error) {
      await this.deps.db.org(ctx.organizationId, (tx) => tx.runtime_jobs.updateMany({
        where: { id: jobId, runtime_id: ctx.runtimeId, status: "leased" }, data: { credential_consumed_at: null },
      }));
      throw error;
    }
  }

  private async leaseJob(tx: Tx, runtimeId: string): Promise<RuntimeJob | null> {
    const rows = await tx.$queryRaw<{ id: string; payload: Record<string, unknown> }[]>`
      UPDATE runtime_jobs
         SET status = 'leased', attempts = attempts + 1, updated_at = now(),
             leased_until = now() + make_interval(secs => ${JOB_LEASE_SECONDS}::integer)
       WHERE id = (
         SELECT id FROM runtime_jobs
          WHERE runtime_id = ${runtimeId}::uuid AND status = 'pending'
          ORDER BY created_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
      RETURNING id, payload`;
    const row = rows[0];
    return row ? ({ ...row.payload, job_id: row.id } as RuntimeJob) : null;
  }

  async browserProfile(ctx: RuntimeContext, profileId: string): Promise<RuntimeBrowserProfile> {
    return this.deps.db.org(ctx.organizationId, async (tx) => {
      await tx.browser_profiles.updateMany({
        where: { id: profileId, runtime_id: ctx.runtimeId, status: "active", expires_at: { lte: new Date() } },
        data: { status: "expired" },
      });
      const profile = await tx.browser_profiles.findFirst({
        where: { id: profileId, runtime_id: ctx.runtimeId, status: "active", expires_at: { gt: new Date() } },
      });
      if (!profile?.runtime_object_key || !profile.expires_at) throw notFound("有効なBrowser Profile");
      const domains = Array.isArray(profile.allowed_domains)
        ? profile.allowed_domains.filter((value): value is string => typeof value === "string")
        : [];
      return {
        profile_id: profile.id,
        runtime_object_key: profile.runtime_object_key,
        allowed_domains: domains,
        expires_at: profile.expires_at.toISOString(),
      };
    });
  }

  async jobResult(ctx: RuntimeContext, jobId: string, req: JobResultRequest): Promise<void> {
    let autoMergeChangeSetId: string | null = null;
    await this.deps.db.org(ctx.organizationId, async (tx) => {
      const job = await tx.runtime_jobs.findFirst({ where: { id: jobId, runtime_id: ctx.runtimeId } });
      if (!job) throw notFound("ジョブ");
      if (job.status !== "leased") return;
      await tx.runtime_jobs.update({
        where: { id: jobId },
        data: {
          status: req.status,
          error: req.error ?? null,
          result: req.output === undefined ? Prisma.JsonNull : req.output as Prisma.InputJsonValue,
          completed_at: new Date(),
          leased_until: null,
        },
      });
      if (job.type === "start_browser_login") {
        const login = await tx.browser_login_sessions.findFirst({ where: { runtime_job_id: jobId, runtime_id: ctx.runtimeId } });
        if (!login) throw notFound("Browser Login Session");
        const profile = await tx.browser_profiles.findFirst({ where: { id: login.profile_id, runtime_id: ctx.runtimeId } });
        if (!profile) throw notFound("Browser Profile");
        if (login.status === "cancelled") {
          await recordAudit(tx, {
            organizationId: ctx.organizationId, actorType: "runtime", actorId: ctx.runtimeId,
            action: "browser_profile.login.result_ignored", targetType: "browser_profile", targetId: profile.id,
            sourceIp: ctx.sourceIp, result: "success", detail: { login_session_id: login.id, reason: "cancelled_by_user" },
          });
          return;
        }
        if (req.status === "succeeded") {
          const output = browserLoginResultSchema.safeParse(req.output);
          const allowed = Array.isArray(profile.allowed_domains) ? profile.allowed_domains.filter((value): value is string => typeof value === "string").sort() : [];
          const verified = output.success ? [...output.data.verified_domains].sort() : [];
          const objectKeyOk = output.success && output.data.runtime_object_key.startsWith(`profiles/${profile.id}/`);
          const expiryOk = output.success && new Date(output.data.expires_at) > new Date() && new Date(output.data.expires_at).getTime() <= Date.now() + 90 * 24 * 60 * 60_000;
          if (!output.success || output.data.login_session_id !== login.id || output.data.profile_id !== profile.id
            || JSON.stringify(verified) !== JSON.stringify(allowed) || !objectKeyOk || !expiryOk) {
            throw new AppError("invalid_job_result", 400, "Browser Profileの検証証跡が一致しません");
          }
          const now = new Date();
          await tx.browser_profiles.update({ where: { id: profile.id }, data: {
            status: "active", runtime_object_key: output.data.runtime_object_key,
            last_verified_at: now, expires_at: new Date(output.data.expires_at), revoked_at: null,
          } });
          if (profile.runtime_object_key && profile.runtime_object_key !== output.data.runtime_object_key) {
            await tx.runtime_jobs.create({ data: {
              organization_id: ctx.organizationId,
              runtime_id: ctx.runtimeId,
              type: "revoke_browser_profile",
              payload: { type: "revoke_browser_profile", profile_id: profile.id, runtime_object_key: profile.runtime_object_key },
            } });
          }
          await tx.browser_login_sessions.update({ where: { id: login.id }, data: { status: "succeeded", completed_at: now, error: null } });
          if (login.human_action_id) await tx.human_actions.updateMany({
            where: { id: login.human_action_id, status: "pending" }, data: { status: "completed", completed_at: now },
          });
          if (login.project_id) {
            const project = await tx.builder_projects.findUnique({ where: { id: login.project_id } });
            const active = await tx.builder_runs.findFirst({ where: { project_id: login.project_id, status: { in: ["queued", "running"] } } });
            if (project && !active) {
              const last = await tx.builder_runs.aggregate({ where: { project_id: project.id }, _max: { attempt: true } });
              const requestHash = (suffix: string) => createHash("sha256").update(`${project.request}${suffix}`).digest("hex");
              await tx.builder_runs.create({ data: {
                organization_id: ctx.organizationId, project_id: project.id, attempt: (last._max.attempt ?? 0) + 1,
                correlation_id: randomUUID(), budget: { max_attempts: 3, phase: "planning", ...(this.deps.env.NODE_ENV === "test" ? { worker_id: this.deps.env.WORKER_ID } : {}) },
                steps: { create: [
                  { kind: "analyze_requirements", input_hash: requestHash("") },
                  { kind: "resolve_capabilities", input_hash: requestHash(":resolve") },
                  { kind: "prepare_human_actions", input_hash: requestHash(":human") },
                ] },
              } });
              await tx.builder_projects.update({ where: { id: project.id }, data: { status: "draft", completed_at: null } });
            }
          }
        } else {
          const expired = login.expires_at <= new Date();
          await tx.browser_login_sessions.update({ where: { id: login.id }, data: {
            status: expired ? "expired" : "failed", completed_at: new Date(),
            error: expired ? "Human Login Sessionの有効期限が切れました" : (req.error ?? "RuntimeでHuman Loginを完了できませんでした").slice(0, 2000),
          } });
        }
        await recordAudit(tx, {
          organizationId: ctx.organizationId, actorType: "runtime", actorId: ctx.runtimeId,
          action: "browser_profile.login.result", targetType: "browser_profile", targetId: profile.id,
          sourceIp: ctx.sourceIp, result: req.status === "succeeded" ? "success" : "failure",
          detail: { login_session_id: login.id, profile_body_returned_to_control_plane: false, auto_resumed: req.status === "succeeded" && Boolean(login.project_id) },
        });
      }
      if (job.type === "revoke_browser_profile" && req.status === "succeeded") {
        const payload = job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
          ? job.payload as Record<string, unknown> : {};
        const profileId = typeof payload.profile_id === "string" ? payload.profile_id : null;
        const objectKey = typeof payload.runtime_object_key === "string" ? payload.runtime_object_key : null;
        if (profileId && objectKey) {
          await tx.browser_profiles.updateMany({
            where: { id: profileId, runtime_id: ctx.runtimeId, status: "revoked", runtime_object_key: objectKey },
            data: { runtime_object_key: null },
          });
        }
      }
      if (req.status === "failed" && job.type === "start_session") {
        if (job.session_id) {
          await this.failSession(tx, job.session_id, `Runtime で作業環境を起動できませんでした: ${req.error ?? "不明なエラー"}`);
        } else {
          const payload = job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
            ? job.payload as Record<string, unknown> : {};
          const rawSession = payload.session && typeof payload.session === "object" && !Array.isArray(payload.session)
            ? payload.session as Record<string, unknown> : {};
          const builderSessionId = typeof rawSession.session_id === "string" ? rawSession.session_id : null;
          if (builderSessionId) {
            await tx.builder_workspace_sessions.updateMany({
              where: { id: builderSessionId, runtime_id: ctx.runtimeId, status: { in: ["creating", "waiting_worker", "connected", "running"] } },
              data: { status: "failed", error_class: "environment_auth", error: `Runtimeで作業環境を起動できませんでした: ${req.error ?? "不明なエラー"}`, finished_at: new Date() },
            });
          }
        }
      }
      if (job.type === "builder_workspace") {
        const payload = job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
          ? job.payload as Record<string, unknown>
          : {};
        const projectId = typeof payload.project_id === "string" ? payload.project_id : null;
        const changeSetId = typeof payload.change_set_id === "string" ? payload.change_set_id : null;
        if (!projectId || !changeSetId) throw new AppError("invalid_job", 400, "Code Workspaceジョブの関連情報がありません");
        const change = await tx.builder_change_sets.findFirst({ where: { id: changeSetId, project_id: projectId } });
        if (!change) throw notFound("Code Workspace Change Set");
        if (req.status === "succeeded") {
          const output = builderWorkspaceResultSchema.safeParse(req.output);
          if (!output.success || output.data.change_set_id !== changeSetId) {
            throw new AppError("invalid_job_result", 400, "Code Workspaceの成功証跡が一致しません");
          }
          const artifacts = Array.isArray(change.artifacts) ? change.artifacts as Array<Record<string, unknown>> : [];
          const durableArtifacts = artifacts.filter((artifact) => !["commit", "diff", "changed_file"].includes(String(artifact.type)));
          durableArtifacts.push(
            { type: "commit", id: output.data.commit_sha, name: output.data.commit_sha.slice(0, 12) },
            { type: "diff", id: output.data.diff_sha256, name: output.data.diff_sha256.slice(0, 16) },
            ...output.data.changed_files.map((path) => ({ type: "changed_file", id: path, name: path })),
          );
          await tx.builder_change_sets.update({
            where: { id: change.id },
            data: { status: "applied", artifacts: durableArtifacts as Prisma.InputJsonValue },
          });
          await tx.builder_validation_runs.create({ data: {
            organization_id: ctx.organizationId,
            project_id: projectId,
            suite: "code_workspace",
            environment: "builder",
            status: "passed",
            evidence: {
              runtime_id: ctx.runtimeId,
              change_set_id: changeSetId,
              commit_sha: output.data.commit_sha,
              diff_sha256: output.data.diff_sha256,
              changed_files: output.data.changed_files,
              tests: output.data.tests,
              source_body_returned_to_control_plane: false,
              secret_values_returned_to_control_plane: false,
            },
            finished_at: new Date(),
          } });
          const pendingPublishActions = await tx.human_actions.findMany({
            where: { project_id: projectId, status: "pending" },
            select: { id: true, resume_condition: true },
          });
          const pendingPublish = pendingPublishActions.find((action) => {
            const condition = action.resume_condition && typeof action.resume_condition === "object" && !Array.isArray(action.resume_condition)
              ? action.resume_condition as Record<string, unknown>
              : {};
            return condition.type === "git_branch_published" && condition.change_set_id === changeSetId;
          });
          if (!pendingPublish) await tx.human_actions.create({ data: {
            organization_id: ctx.organizationId,
            project_id: projectId,
            type: "provider_app_registration",
            title: "組織の開発基盤にGitHub Appを設定してください",
            reason: "生成とテストは顧客Runtime内で完了しました。専用Connectionでbranchをpushし、同じcommitからPRを作成する必要があります",
            assignee_role: "admin",
            fields: [],
            instructions: [
              "設定の「実行・開発基盤」でGitHub Appを接続します",
              "Builderが隔離workspaceのcommitを専用branchへpushします",
              "差分hashが一致するPRを作成し、検証後に自動再開します",
            ],
            resume_condition: { type: "git_branch_published", change_set_id: changeSetId, commit_sha: output.data.commit_sha },
          } });
          await tx.builder_projects.update({ where: { id: projectId }, data: { status: "waiting_human_action" } });
        } else {
          await tx.builder_validation_runs.create({ data: {
            organization_id: ctx.organizationId,
            project_id: projectId,
            suite: "code_workspace",
            environment: "builder",
            status: "failed",
            evidence: { runtime_id: ctx.runtimeId, change_set_id: changeSetId },
            error_class: "execution",
            error: (req.error ?? "Code Workspaceの実行に失敗しました").slice(0, 2000),
            finished_at: new Date(),
          } });
          await tx.builder_projects.update({ where: { id: projectId }, data: { status: "failed" } });
        }
        await recordAudit(tx, {
          organizationId: ctx.organizationId,
          actorType: "runtime",
          actorId: ctx.runtimeId,
          action: "builder.code_workspace.result",
          targetType: "builder_change_set",
          targetId: changeSetId,
          sourceIp: ctx.sourceIp,
          result: req.status === "succeeded" ? "success" : "failure",
          detail: { project_id: projectId, job_id: jobId, evidence_only: true },
        });
      }
      if (job.type === "publish_builder_branch") {
        const payload = job.payload && typeof job.payload === "object" && !Array.isArray(job.payload) ? job.payload as Record<string, unknown> : {};
        const projectId = typeof payload.project_id === "string" ? payload.project_id : null;
        const changeSetId = typeof payload.change_set_id === "string" ? payload.change_set_id : null;
        const connectionId = typeof payload.connection_id === "string" ? payload.connection_id : null;
        if (!projectId || !changeSetId || !connectionId) throw new AppError("invalid_job", 400, "Git公開ジョブの関連情報がありません");
        const change = await tx.builder_change_sets.findFirst({ where: { id: changeSetId, project_id: projectId } });
        if (!change) throw notFound("Code Workspace Change Set");
        if (req.status === "succeeded") {
          const output = gitPublishResultSchema.safeParse(req.output);
          if (!output.success || output.data.change_set_id !== changeSetId || output.data.head_sha !== change.head_sha || output.data.base_sha !== change.base_sha) {
            throw new AppError("invalid_job_result", 400, "Git branch公開のSHA証跡が一致しません");
          }
          const connection = await tx.connections.findFirst({ where: { id: connectionId, organization_id: ctx.organizationId, status: "connected" } });
          if (!connection?.secret_locator) throw new AppError("git_connection_unavailable", 412, "GitHub App Connectionが利用できません");
          const metadata = parseGitHubAppMetadata(connection.metadata);
          const stored = await this.deps.secrets.get(connection.secret_locator);
          if (!stored) throw new AppError("git_connection_unavailable", 412, "GitHub Appの秘密鍵が見つかりません");
          const artifacts = Array.isArray(change.artifacts) ? change.artifacts as Array<Record<string, unknown>> : [];
          const diffHash = artifacts.find((artifact) => artifact.type === "diff")?.id;
          const changedFiles = artifacts.filter((artifact) => artifact.type === "changed_file").map((artifact) => String(artifact.id));
          const validation = await tx.builder_validation_runs.findFirst({ where: { project_id: projectId, suite: "builder_session", status: "passed" }, orderBy: { created_at: "desc" } });
          const validationEvidence = validation?.evidence && typeof validation.evidence === "object" && !Array.isArray(validation.evidence)
            ? validation.evidence as Record<string, unknown> : {};
          const tests = Array.isArray(validationEvidence.tests) ? validationEvidence.tests : [];
          const pull = await this.deps.gitProvider.createOrUpdatePullRequest({
            metadata,
            secret: parseGitHubAppSecret(stored),
            branch: output.data.branch,
            headSha: output.data.head_sha,
            baseSha: output.data.base_sha,
            title: `[Agent Studio] ${change.summary}`.slice(0, 240),
            body: [
              `Change Set: ${change.id}`,
              `Purpose: ${change.summary}`,
              `Changed files: ${changedFiles.join(", ") || "none"}`,
              `Tests: ${tests.map((test) => JSON.stringify(test)).join(", ") || "recorded in Builder evidence"}`,
              `Diff SHA-256: ${typeof diffHash === "string" ? diffHash : "unknown"}`,
              "Data boundary: no secrets, customer data, raw bank images, source body, or model reasoning are included in this PR description.",
            ].join("\n\n"),
          });
          await tx.builder_change_sets.update({ where: { id: change.id }, data: {
            status: "pr_open", pr_url: pull.html_url, pr_number: pull.number, head_sha: pull.head.sha, base_sha: pull.base.sha,
          } });
          await tx.builder_validation_runs.create({ data: {
            organization_id: ctx.organizationId,
            project_id: projectId,
            suite: "git_provider",
            environment: "builder",
            status: "passed",
            evidence: { change_set_id: changeSetId, connection_id: connectionId, repository_id: metadata.repository_id, branch: output.data.branch, pr_url: pull.html_url, pr_number: pull.number, head_sha: pull.head.sha, base_sha: pull.base.sha, idempotent_pr: true },
            finished_at: new Date(),
          } });
          await tx.human_actions.updateMany({ where: { project_id: projectId, type: "provider_app_registration", status: "pending" }, data: { status: "completed", completed_at: new Date() } });
          const mergeAction = await tx.human_actions.findFirst({ where: { project_id: projectId, type: "repository_merge", status: "pending" } });
          if (!mergeAction) await tx.human_actions.create({ data: {
            organization_id: ctx.organizationId,
            project_id: projectId,
            type: "repository_merge",
            title: `PR #${pull.number}の変更をIntegration Repositoryへ反映します`,
            reason: "Required Checksと管理者の承認を通過したmerge commitだけをAdapter配布へ進めるためです",
            assignee_role: "admin",
            fields: [],
            instructions: [pull.html_url, "承認時にRequired Checksとhead SHAを再検証します", "承認後は既定branchへのmerge、デプロイ、RuntimeへのTool登録まで自動で追跡します"],
            resume_condition: { type: "git_pr_merged", change_set_id: changeSetId, pr_number: pull.number, head_sha: pull.head.sha },
          } });
          autoMergeChangeSetId = changeSetId;
          await tx.builder_projects.update({ where: { id: projectId }, data: { status: "waiting_human_action" } });
        } else {
          await tx.builder_change_sets.update({ where: { id: change.id }, data: { status: "failed" } });
          await tx.builder_projects.update({ where: { id: projectId }, data: { status: "failed" } });
          await tx.builder_validation_runs.create({ data: {
            organization_id: ctx.organizationId, project_id: projectId, suite: "git_provider", environment: "builder", status: "failed",
            evidence: { change_set_id: changeSetId, job_id: jobId, force_push_used: false, default_branch_push_used: false },
            error_class: "git_push", error: (req.error ?? "専用branchを公開できませんでした").slice(0, 2000), finished_at: new Date(),
          } });
        }
        await recordAudit(tx, {
          organizationId: ctx.organizationId, actorType: "runtime", actorId: ctx.runtimeId, action: "builder.git.publish", targetType: "builder_change_set", targetId: changeSetId,
          sourceIp: ctx.sourceIp, result: req.status === "succeeded" ? "success" : "failure", detail: { project_id: projectId, job_id: jobId, evidence_only: true },
        });
      }
    });
    if (autoMergeChangeSetId) await this.gitAutomation.tryAutoMerge(ctx.organizationId, autoMergeChangeSetId, ctx.sourceIp);
  }

  /** Session Worker の状態の報告 */
  async sessionEvent(ctx: RuntimeContext, sessionId: string, req: SessionEventRequest): Promise<void> {
    await this.deps.db.org(ctx.organizationId, async (tx) => {
      const session = await tx.agent_sessions.findFirst({ where: { id: sessionId, runtime_id: ctx.runtimeId } });
      if (!session) {
        const builder = await tx.builder_workspace_sessions.findFirst({ where: { id: sessionId, runtime_id: ctx.runtimeId } });
        if (!builder) throw notFound("セッション");
        switch (req.type) {
          case "worker_starting":
            await tx.builder_workspace_sessions.update({ where: { id: sessionId }, data: { worker_task_arn: req.task_arn ?? builder.worker_task_arn, last_event_at: new Date() } });
            break;
          case "worker_running":
            await tx.builder_workspace_sessions.update({ where: { id: sessionId }, data: { last_event_at: new Date() } });
            if (builder.openai_environment_id) {
              const api = await this.deps.agentsApi.forOrganization(ctx.organizationId);
              api.simulateWorkerConnected?.(builder.openai_environment_id);
            }
            break;
          case "worker_stopped":
            await tx.builder_workspace_sessions.update({ where: { id: sessionId }, data: { worker_task_arn: null, last_event_at: new Date() } });
            break;
          case "worker_failed":
            await tx.builder_workspace_sessions.update({ where: { id: sessionId }, data: {
              status: "failed", error_class: "environment_auth", error: `作業環境が異常終了しました: ${req.detail ?? "不明なエラー"}`,
              finished_at: new Date(), last_event_at: new Date(), lease_owner: null, lease_until: null,
            } });
            await tx.builder_projects.update({ where: { id: builder.project_id }, data: { status: "failed" } });
            break;
        }
        return;
      }
      const run = { id: session.run_id, organization_id: session.organization_id };
      switch (req.type) {
        case "worker_starting":
          await tx.agent_sessions.update({ where: { id: sessionId }, data: { worker_task_arn: req.task_arn ?? session.worker_task_arn } });
          await appendRunEvent(tx, run, "environment.status", "Runtime が作業環境を起動しています", { worker: req.type });
          break;
        case "worker_running":
          await appendRunEvent(tx, run, "environment.status", "作業環境が起動しました。OpenAI への接続を待っています", { worker: req.type });
          if (session.openai_environment_id) {
            const api = await this.deps.agentsApi.forOrganization(ctx.organizationId);
            api.simulateWorkerConnected?.(session.openai_environment_id);
          }
          break;
        case "worker_stopped":
          if (!session.ended_at) {
            await tx.agent_sessions.update({ where: { id: sessionId }, data: { worker_task_arn: null } });
            await appendRunEvent(tx, run, "environment.status", "作業環境が停止しました", { worker: req.type, detail: req.detail });
          }
          break;
        case "worker_failed":
          await this.failSession(tx, sessionId, `作業環境が異常終了しました: ${req.detail ?? "不明なエラー"}`);
          break;
      }
    });
  }

  private async failSession(tx: Tx, sessionId: string, message: string) {
    const session = await tx.agent_sessions.update({ where: { id: sessionId }, data: { status: "failed" } });
    await appendRunEvent(tx, { id: session.run_id, organization_id: session.organization_id }, "error", message, {});
  }

  /**
   * Runtime内で取得したファイル（Browser Download）をRun Artifactとして保存する。
   * 自分のRuntimeが持つ実行中Sessionだけを受け付け、hash・サイズ・安全検査をこちらでもやり直す。
   */
  async storeSessionArtifact(ctx: RuntimeContext, sessionId: string, req: SessionArtifactRequest): Promise<SessionArtifactResponse> {
    const bucket = this.deps.env.ARTIFACTS_BUCKET;
    if (!bucket) throw new AppError("artifacts_unavailable", 503, "成果物の保存先が設定されていません");
    const session = await this.deps.db.org(ctx.organizationId, (tx) =>
      tx.agent_sessions.findFirst({ where: { id: sessionId, runtime_id: ctx.runtimeId, ended_at: null }, select: { id: true, run_id: true } }),
    );
    if (!session) throw notFound("セッション");

    const body = Buffer.from(req.content_base64, "base64");
    if (body.byteLength !== req.size_bytes) throw new AppError("artifact_mismatch", 400, "ファイルのサイズが一致しません");
    const path = `browser-downloads/${req.source_artifact_id}/${req.filename}`;
    const inspected = inspectArtifact(path, body);
    if (inspected.sha256 !== req.sha256) throw new AppError("artifact_mismatch", 400, "ファイルのhashが一致しません");
    const objectKey = `${artifactPrefix(ctx.organizationId, session.run_id)}${inspected.path}`;
    if (inspected.scanStatus === "passed") await this.deps.objects.put(bucket, objectKey, body, inspected.mimeType);
    const retainedUntil = new Date(Date.now() + 30 * 24 * 60 * 60_000);

    const artifact = await this.deps.db.org(ctx.organizationId, async (tx) => {
      const saved = await tx.run_artifacts.upsert({
        where: { organization_id_run_id_path: { organization_id: ctx.organizationId, run_id: session.run_id, path: inspected.path } },
        create: {
          organization_id: ctx.organizationId, run_id: session.run_id, path: inspected.path, object_key: objectKey,
          mime_type: inspected.mimeType, size_bytes: body.byteLength, sha256: inspected.sha256,
          scan_status: inspected.scanStatus, scan_engine: inspected.scanEngine, source: req.source, retained_until: retainedUntil,
        },
        update: {},
      });
      if (saved.sha256 !== inspected.sha256) throw new AppError("artifact_conflict", 409, "同じArtifact IDで別のファイルが保存されています");
      await appendRunEvent(tx, { id: session.run_id, organization_id: ctx.organizationId }, "message",
        inspected.scanStatus === "passed" ? `Downloadしたファイルを成果物として保存しました: ${req.filename}` : `Downloadしたファイルは安全検査で拒否されました: ${req.filename}`,
        { role: "system", text: `${inspected.path} (${inspected.scanStatus}, ${body.byteLength} bytes, sha256 ${inspected.sha256})` },
      );
      await recordAudit(tx, {
        organizationId: ctx.organizationId,
        actorType: "runtime",
        actorId: ctx.runtimeId,
        action: "artifact.store",
        targetType: "run",
        targetId: session.run_id,
        result: inspected.scanStatus === "passed" ? "success" : "denied",
        sourceIp: ctx.sourceIp,
        detail: { session_id: sessionId, source: req.source, artifact_id: saved.id, path: inspected.path, mime_type: inspected.mimeType, bytes: body.byteLength, sha256: inspected.sha256, scan_status: inspected.scanStatus },
      });
      return saved;
    });
    if (inspected.scanStatus !== "passed") throw new AppError("artifact_rejected", 400, "安全検査で拒否されたファイルです");
    return { run_artifact_id: artifact.id, path: artifact.path, scan_status: "passed", retained_until: artifact.retained_until.toISOString() };
  }

  /** Tool Gateway がツール呼び出しを認可するための情報（Controller の再起動時に使う） */
  async activeSessions(ctx: RuntimeContext): Promise<SessionGrant[]> {
    return this.deps.db.org(ctx.organizationId, async (tx) => {
      const sessions = await tx.agent_sessions.findMany({
        where: {
          runtime_id: ctx.runtimeId,
          ended_at: null,
          status: { in: ["waiting_worker", "connected"] },
          token_hash: { not: null },
          expires_at: { gt: new Date() },
        },
      });
      const builderSessions = await tx.builder_workspace_sessions.findMany({
        where: {
          runtime_id: ctx.runtimeId,
          status: { in: ["waiting_worker", "connected", "running"] },
          expires_at: { gt: new Date() },
        },
      });
      return [...sessions.map((s) => ({
        session_id: s.id,
        run_id: s.run_id,
        token_hash: s.token_hash!,
        allowed_tools: s.allowed_tools as string[],
        policies: s.policies as unknown as Policy[],
        expires_at: s.expires_at!.toISOString(),
      })), ...builderSessions.map((s) => ({
        session_id: s.id,
        run_id: s.change_set_id,
        token_hash: s.token_hash,
        allowed_tools: [],
        policies: [],
        expires_at: s.expires_at.toISOString(),
      }))];
    });
  }

  /** 承認依頼（Tool Gateway から）。同じセッション・同じ引数の依頼があればそれを返す（POL-04） */
  async createApproval(ctx: RuntimeContext, req: ApprovalRequest): Promise<ApprovalResponse> {
    return this.deps.db.org(ctx.organizationId, async (tx) => {
      const session = await tx.agent_sessions.findFirst({
        where: { id: req.session_id, runtime_id: ctx.runtimeId, ended_at: null },
        include: { run: { include: { deployment: true } } },
      });
      if (!session) throw notFound("セッション");
      const existing = await tx.approvals.findFirst({
        where: { session_id: session.id, args_hash: req.args_hash, tool: req.tool, status: { in: ["pending", "approved"] } },
        orderBy: { requested_at: "desc" },
      });
      if (existing) return { approval_id: existing.id, status: await this.currentStatus(tx, existing) };

      const auto = req.risk
        ? await evaluateOrganizationAutoApproval(tx, ctx.organizationId, {
            actionKind: "api_call",
            stage: session.run.deployment.stage as "staging" | "production",
            operation: req.tool,
            risk: req.risk,
            host: req.destination_host ?? null,
            method: req.method ?? null,
            requestedRecords: req.requested_records ?? null,
            now: new Date(),
          })
        : { policy: null, decision: { action: "manual_required" as const, reason: "Runtimeがrisk情報を送信していません" } };
      const autoApproved = Boolean(auto.policy && auto.decision.action === "auto_approve");
      const decidedAt = autoApproved ? new Date() : null;
      const approval = await tx.approvals.create({
        data: {
          organization_id: ctx.organizationId,
          run_id: session.run_id,
          session_id: session.id,
          source: "runtime_gateway",
          tool: req.tool,
          args_hash: req.args_hash,
          args_preview: req.args_preview,
          reason: req.reason,
          status: autoApproved ? "approved" : "pending",
          expires_at: new Date(Date.now() + req.timeout_minutes * 60 * 1000),
          decided_at: decidedAt,
          auto_approved: autoApproved,
          auto_approval_policy_id: autoApproved ? auto.policy!.id : null,
          auto_approval_policy_version: autoApproved ? auto.policy!.version : null,
          auto_approval_reason: autoApproved ? auto.decision.reason : null,
        },
      });
      await appendRunEvent(
        tx,
        { id: session.run_id, organization_id: session.organization_id },
        autoApproved ? "approval.decided" : "approval.requested",
        autoApproved ? `${req.tool} を組織Policyが自動承認しました` : `${req.tool} の実行に承認が必要です: ${req.reason}`,
        autoApproved
          ? { approval_id: approval.id, tool: req.tool, policy_id: auto.policy!.id, policy_version: auto.policy!.version, reason: auto.decision.reason }
          : { approval_id: approval.id, tool: req.tool, args_preview: req.args_preview },
      );
      await recordAudit(tx, {
        organizationId: ctx.organizationId,
        actorType: autoApproved ? "system" : "runtime",
        actorId: autoApproved ? "organization_policy" : ctx.runtimeId,
        action: autoApproved ? "approval.auto_approve" : "approval.request",
        targetType: "approval",
        targetId: approval.id,
        sourceIp: ctx.sourceIp,
        detail: autoApproved
          ? { tool: req.tool, run_id: session.run_id, policy_id: auto.policy!.id, policy_version: auto.policy!.version, reason: auto.decision.reason }
          : { tool: req.tool, run_id: session.run_id },
      });
      return { approval_id: approval.id, status: autoApproved ? "approved" : "pending" };
    });
  }

  async getApproval(ctx: RuntimeContext, approvalId: string): Promise<ApprovalResponse> {
    return this.deps.db.org(ctx.organizationId, async (tx) => {
      const approval = await this.ownApproval(tx, ctx, approvalId);
      return { approval_id: approval.id, status: await this.currentStatus(tx, approval) };
    });
  }

  /** 承認済みの依頼を1回だけ使う。使えた場合だけ status=consumed を返す */
  async consumeApproval(ctx: RuntimeContext, approvalId: string): Promise<ApprovalResponse> {
    return this.deps.db.org(ctx.organizationId, async (tx) => {
      const approval = await this.ownApproval(tx, ctx, approvalId);
      const updated = await tx.approvals.updateMany({
        where: { id: approval.id, status: "approved", expires_at: { gt: new Date() } },
        data: { status: "consumed", consumed_at: new Date() },
      });
      return { approval_id: approval.id, status: updated.count === 1 ? "consumed" : await this.currentStatus(tx, approval) };
    });
  }

  private async ownApproval(tx: Tx, ctx: RuntimeContext, approvalId: string) {
    const approval = await tx.approvals.findFirst({ where: { id: approvalId, source: "runtime_gateway" }, include: { session: true } });
    if (!approval || approval.session?.runtime_id !== ctx.runtimeId) throw notFound("承認依頼");
    return approval;
  }

  private async currentStatus(tx: Tx, approval: { id: string; status: string; expires_at: Date }): Promise<ApprovalStatus> {
    if (approval.status === "pending" && approval.expires_at < new Date()) {
      await tx.approvals.update({ where: { id: approval.id }, data: { status: "expired" } });
      return "expired";
    }
    return approval.status as ApprovalStatus;
  }

  /** Tool Gateway の監査イベント（AUD-05） */
  async audit(ctx: RuntimeContext, events: ToolAuditEvent[]): Promise<void> {
    await this.deps.db.org(ctx.organizationId, async (tx) => {
      const sessionIds = [...new Set(events.map((e) => e.session_id))];
      const owned = new Set(
        (await tx.agent_sessions.findMany({ where: { id: { in: sessionIds }, runtime_id: ctx.runtimeId }, select: { id: true } })).map((s) => s.id),
      );
      await recordAudit(
        tx,
        events
          .filter((e) => owned.has(e.session_id))
          .map((e) => ({
            organizationId: ctx.organizationId,
            actorType: "runtime" as const,
            actorId: ctx.runtimeId,
            action: `tool.${e.decision}`,
            targetType: "session",
            targetId: e.session_id,
            result: e.decision === "denied" ? ("denied" as const) : e.decision === "failed" ? ("failure" as const) : ("success" as const),
            sourceIp: ctx.sourceIp,
            detail: { tool: e.tool, args_hash: e.args_hash, detail: e.detail, duration_ms: e.duration_ms, at: e.at },
          })),
      );
    });
  }

  async environmentKey(ctx: RuntimeContext): Promise<{ environment_key: string | null }> {
    const key = await this.environmentKeyOf(ctx.organizationId);
    await this.deps.db.org(ctx.organizationId, (tx) =>
      recordAudit(tx, {
        organizationId: ctx.organizationId,
        actorType: "runtime",
        actorId: ctx.runtimeId,
        action: "runtime.environment_key.fetch",
        targetType: "runtime",
        targetId: ctx.runtimeId,
        sourceIp: ctx.sourceIp,
      }),
    );
    return { environment_key: key };
  }

  private async environmentKeyOf(organizationId: string): Promise<string | null> {
    const settings = await this.deps.db.org(organizationId, (tx) =>
      tx.organization_openai_settings.findUnique({ where: { organization_id: organizationId } }),
    );
    return settings?.env_key_secret_arn ? this.deps.secrets.get(settings.env_key_secret_arn) : null;
  }
}
