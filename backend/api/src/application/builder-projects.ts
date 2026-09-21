import { randomUUID, createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { BuilderProjectDto, CompleteBuilderHumanActionInput, ConnectionDto, CreateBuilderProjectInput, CreateRuntimeInput, MemberRole } from "@agent-studio/contracts";
import { conflict, notFound, validationError } from "../domain/errors.js";
import { inferCodeWorkspaceInterface } from "../domain/builder-interface.js";
import { isOrganizationIntegrationRepository } from "../domain/git-repository-policy.js";
import { parseGitHubAppMetadata, parseGitHubAppSecret } from "../infrastructure/git/github-app.js";
import { recordAudit } from "../infrastructure/audit.js";
import { auditBy, requireRole, scopeOf, type MemberActor } from "./context.js";
import type { Deps } from "./deps.js";
import { toBuilderProjectDto } from "./dto.js";
import { setRunStatus } from "./run-events.js";
import { EnvironmentService } from "./environments.js";
import { RunService } from "./runs.js";

const includeProject = {
  plans: { orderBy: { version: "desc" as const }, take: 1 },
  gaps: { orderBy: { created_at: "asc" as const } },
  human_actions: { orderBy: { created_at: "desc" as const } },
  discovery_sources: { orderBy: { created_at: "desc" as const } },
  change_sets: { orderBy: { created_at: "desc" as const } },
  validation_runs: { orderBy: { created_at: "desc" as const } },
  releases: { orderBy: { created_at: "desc" as const } },
  runs: {
    orderBy: { attempt: "desc" as const },
    include: { steps: { orderBy: { created_at: "asc" as const } } },
  },
};

function requestHash(request: string) {
  return createHash("sha256").update(request).digest("hex");
}

function shellName(request: string) {
  const firstLine = request.split(/\r?\n/, 1)[0]?.trim() || "新しいAgent";
  return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
}

export interface AutomaticProductionApproval {
  approvalId: string;
  policyId: string;
  policyVersion: number;
  reason: string;
}

export class BuilderProjectService {
  private readonly environments: EnvironmentService;
  private readonly runs: RunService;

  constructor(private readonly deps: Deps) {
    this.environments = new EnvironmentService(deps);
    this.runs = new RunService(deps);
  }

  async list(actor: MemberActor): Promise<BuilderProjectDto[]> {
    return this.deps.db.run(scopeOf(actor), async (tx) =>
      (
        await tx.builder_projects.findMany({
          where: { organization_id: actor.organizationId },
          include: includeProject,
          orderBy: { updated_at: "desc" },
          take: 100,
        })
      ).map(toBuilderProjectDto),
    );
  }

  async get(actor: MemberActor, id: string): Promise<BuilderProjectDto> {
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const project = await tx.builder_projects.findFirst({
        where: { id, organization_id: actor.organizationId },
        include: includeProject,
      });
      if (!project) throw notFound("作成プロジェクト");
      return toBuilderProjectDto(project);
    });
  }

  async create(actor: MemberActor, input: CreateBuilderProjectInput): Promise<BuilderProjectDto> {
    requireRole(actor, "builder");
    const projectId = await this.deps.db.run(scopeOf(actor), async (tx) => {
      const agentId = await this.createAgentShell(tx, actor, input.request);
      const project = await tx.builder_projects.create({
        data: {
          organization_id: actor.organizationId,
          agent_id: agentId,
          request: input.request,
          target: input.target ?? "preview",
          created_by: actor.userId,
        },
      });
      await this.enqueue(tx, actor.organizationId, project.id, input.request, 1);
      await recordAudit(
        tx,
        auditBy(actor, {
          action: "builder.project.create",
          targetType: "builder_project",
          targetId: project.id,
          detail: { target: input.target ?? "preview" },
        }),
      );
      return project.id;
    });
    return this.get(actor, projectId);
  }

  /** 旧URL/旧レコードを、利用者に見せるAgentへ安全に移行する。 */
  async ensureAgent(actor: MemberActor, id: string): Promise<BuilderProjectDto> {
    requireRole(actor, "builder");
    await this.deps.db.run(scopeOf(actor), async (tx) => {
      const project = await tx.builder_projects.findFirst({ where: { id, organization_id: actor.organizationId } });
      if (!project) throw notFound("作成プロジェクト");
      if (project.agent_id) return;
      await this.ensureProjectAgent(tx, actor, project);
    });
    return this.get(actor, id);
  }

  async resume(actor: MemberActor, id: string): Promise<BuilderProjectDto> {
    requireRole(actor, "builder");
    await this.deps.db.run(scopeOf(actor), async (tx) => {
      const project = await tx.builder_projects.findFirst({ where: { id, organization_id: actor.organizationId } });
      if (!project) throw notFound("作成プロジェクト");
      await this.ensureProjectAgent(tx, actor, project);
      const active = await tx.builder_runs.findFirst({ where: { project_id: id, status: { in: ["queued", "running"] } } });
      if (active) throw conflict("この作成プロジェクトはすでに処理中です");
      const last = await tx.builder_runs.aggregate({ where: { project_id: id }, _max: { attempt: true } });
      await this.enqueue(tx, actor.organizationId, id, project.request, (last._max.attempt ?? 0) + 1);
      await tx.builder_projects.update({ where: { id }, data: { status: "draft", completed_at: null } });
      await recordAudit(
        tx,
        auditBy(actor, { action: "builder.project.resume", targetType: "builder_project", targetId: id, detail: {} }),
      );
    });
    return this.get(actor, id);
  }

  async completeHumanAction(actor: MemberActor, actionId: string, input: CompleteBuilderHumanActionInput = { answers: {} }): Promise<BuilderProjectDto> {
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const action = await tx.human_actions.findFirst({
        where: { id: actionId, organization_id: actor.organizationId },
        include: { project: true },
      });
      if (!action) throw notFound("準備が必要な操作");
      requireRole(actor, action.assignee_role as MemberRole);
      if (action.status !== "pending") throw conflict("この操作はすでに完了しています");
      if (action.type === "human_login") throw conflict("Browser Profileでログイン完了を検知した後に自動再開します");
      const automaticCondition = action.resume_condition && typeof action.resume_condition === "object" && !Array.isArray(action.resume_condition)
        ? action.resume_condition as Record<string, unknown>
        : {};
      const actionTopic = typeof automaticCondition.topic === "string" ? automaticCondition.topic : "";
      if (automaticCondition.type === "browser_runtime_ready") throw conflict("Browser RuntimeのHeartbeatとTool Catalog検証後に自動再開します");
      if (automaticCondition.type === "code_workspace_runtime_ready") throw conflict("Code Workspace対応RuntimeのHeartbeat検証後に自動再開します");
      if (automaticCondition.type === "git_branch_published") throw conflict("Git Connectionでbranch pushとPR作成を検証した後に自動再開します");
      if (action.type === "repository_merge") {
        if (automaticCondition.type !== "git_pr_merged"
          || typeof automaticCondition.change_set_id !== "string"
          || typeof automaticCondition.pr_number !== "number"
          || typeof automaticCondition.head_sha !== "string") {
          throw conflict("PRの反映条件が見つかりません。Builderを再実行してください");
        }
        const change = await tx.builder_change_sets.findFirst({
          where: {
            id: automaticCondition.change_set_id,
            project_id: action.project_id,
            status: "pr_open",
            pr_number: automaticCondition.pr_number,
            head_sha: automaticCondition.head_sha,
          },
        });
        if (!change?.head_sha) throw conflict("反映対象のPRが見つからないか、すでに反映済みです");
        const artifacts = Array.isArray(change.artifacts) ? change.artifacts as Array<Record<string, unknown>> : [];
        const repositoryUrl = artifacts.find((artifact) => artifact.type === "repository")?.id;
        if (typeof repositoryUrl !== "string") throw conflict("反映先Repositoryを確認できません");
        const connection = await tx.connections.findFirst({
          where: {
            organization_id: actor.organizationId,
            status: "connected",
            revoked_at: null,
            metadata: { path: ["repository_url"], equals: repositoryUrl },
          },
        });
        if (!connection?.secret_locator) throw conflict("反映先のGitHub App Connectionが利用できません");
        const metadata = parseGitHubAppMetadata(connection.metadata);
        if (!isOrganizationIntegrationRepository(metadata as unknown as Record<string, unknown>)) {
          throw conflict("企業専用ToolをAgent Studio本体へ反映することはできません。企業専用Integration Repositoryへ変更してください");
        }
        const stored = await this.deps.secrets.get(connection.secret_locator);
        if (!stored) throw conflict("GitHub Appの秘密鍵が見つかりません");
        const secret = parseGitHubAppSecret(stored);
        const [pull, checks] = await Promise.all([
          this.deps.gitProvider.getPullRequest(metadata, secret, automaticCondition.pr_number),
          this.deps.gitProvider.getRequiredChecks(metadata, secret, change.head_sha),
        ]);
        if (pull.merged) throw conflict("PRはすでにmerge済みです。GitHubからの完了通知を待っています");
        if (pull.state !== "open" || pull.head.sha !== change.head_sha || pull.base.ref !== metadata.base_branch) {
          throw conflict("PRのbranchまたはcommitが作成時から変わっています。再生成してください");
        }
        // Agent Studioが新規作成したIntegration Repositoryは、最初のPR時点では
        // GitHub Actions workflowをまだ持たない。0件のCheckを永久待ちにせず、同じ
        // head SHAに固定されたBuilder Sessionの全テスト成功をRequired Checkとして扱う。
        // GitHub側にCheckが1件でも存在する場合は従来どおり全件完了・成功を必須にする。
        const builderValidation = checks.checks.length === 0
          ? await tx.builder_validation_runs.findFirst({
              where: {
                project_id: action.project_id,
                suite: "builder_session",
                environment: "builder",
                status: "passed",
                evidence: { path: ["commit_sha"], equals: change.head_sha },
              },
              orderBy: { created_at: "desc" },
            })
          : null;
        const acceptedChecks = checks.checks.length > 0
          ? checks.complete && checks.successful
          : Boolean(builderValidation);
        if (!acceptedChecks) {
          if (checks.checks.length > 0 && checks.complete) throw conflict("GitHubの自動テストが失敗しています。修正後に再実行してください");
          throw conflict("同じ変更内容の自動テストがまだ完了していません。完了後に自動反映できます");
        }
        const verifiedChecks = checks.checks.length > 0
          ? checks.checks
          : ["agent-studio-builder-session:completed:success"];
        let merged: Awaited<ReturnType<Deps["gitProvider"]["mergePullRequest"]>>;
        try {
          merged = await this.deps.gitProvider.mergePullRequest(metadata, secret, pull.number, change.head_sha);
        } catch (error) {
          const detail = error instanceof Error ? error.message.replace(/^GitHub App request failed:\s*/i, "") : "Repository policyを確認してください";
          throw conflict(`GitHubでPRをmergeできませんでした: ${detail}`);
        }
        if (!merged.merged || !merged.sha) throw conflict(merged.message || "GitHubでPRをmergeできませんでした");
        await tx.builder_change_sets.update({
          where: { id: change.id },
          data: { status: "merged", merge_sha: merged.sha },
        });
        await tx.builder_validation_runs.create({ data: {
          organization_id: actor.organizationId,
          project_id: action.project_id,
          suite: "git_merge",
          environment: "builder",
          status: "passed",
          evidence: {
            change_set_id: change.id,
            pr_number: pull.number,
            head_sha: change.head_sha,
            base_sha: pull.base.sha,
            merge_sha: merged.sha,
            checks: verifiedChecks,
          },
          finished_at: new Date(),
        } });
        await tx.human_actions.update({
          where: { id: action.id },
          data: {
            response: { merge_requested: "true", merge_sha: merged.sha },
            status: "completed",
            completed_at: new Date(),
          },
        });
        const deliveryAction = await tx.human_actions.findFirst({
          where: { project_id: action.project_id, type: "adapter_delivery", status: "pending" },
        });
        if (!deliveryAction) await tx.human_actions.create({ data: {
          organization_id: actor.organizationId,
          project_id: action.project_id,
          type: "adapter_delivery",
          title: "署名付きAdapter packageのPreview配布を待っています",
          reason: "merge commitからのCI build、SBOM、scan、署名、digest固定を検証してからToolを登録するためです",
          assignee_role: "admin",
          fields: [],
          instructions: [
            "CIでmerge commitからpackageをbuildします",
            "GitHub Deploymentのpayloadへ署名・digest・scan証跡を含めます",
            "Runtime heartbeat一致で自動再開します",
          ],
          resume_condition: { type: "adapter_registered", change_set_id: change.id, merge_sha: merged.sha },
        } });
        await tx.builder_projects.update({
          where: { id: action.project_id },
          data: { status: "waiting_human_action" },
        });
        await recordAudit(tx, auditBy(actor, {
          action: "builder.repository_merge.approve",
          targetType: "builder_change_set",
          targetId: change.id,
          detail: { project_id: action.project_id, repository: `${metadata.owner}/${metadata.repository}`, pr_number: pull.number, head_sha: change.head_sha, checks: verifiedChecks },
        }));
        const project = await tx.builder_projects.findUniqueOrThrow({ where: { id: action.project_id }, include: includeProject });
        return toBuilderProjectDto(project);
      }
      let answers = input.answers ?? {};
      const fields = action.fields as Array<{
        name?: unknown;
        label?: unknown;
        secret?: unknown;
        required?: unknown;
        options?: Array<{ value?: unknown; label?: unknown }>;
      }>;
      if (fields.some((field) => field.secret === true)) throw validationError("Secretはこの回答欄ではなくConnectionの専用入力へ保存してください");
      const allowed = new Set(fields.flatMap((field) => typeof field.name === "string" ? [field.name] : []));
      const unknown = Object.keys(answers).filter((name) => !allowed.has(name));
      if (unknown.length) throw validationError(`未定義の回答項目です: ${unknown.join("、")}`);
      for (const field of fields) {
        if (typeof field.name !== "string" || !field.options?.length || !answers[field.name]) continue;
        const values = new Set(field.options.flatMap((option) => typeof option.value === "string" ? [option.value] : []));
        if (!values.has(answers[field.name]!)) throw validationError(`${typeof field.label === "string" ? field.label : field.name}の選択肢が正しくありません`);
      }
      if (actionTopic.startsWith("code_workspace:")) {
        const selectedConnectionId = answers.repository_connection_id?.trim()
          || (typeof automaticCondition.repository_connection_id === "string" ? automaticCondition.repository_connection_id : "");
        let repositoryUrl = typeof automaticCondition.repository_url === "string" ? automaticCondition.repository_url.trim() : "";
        let baseBranch = typeof automaticCondition.base_branch === "string" ? automaticCondition.base_branch.trim() : "";
        if (selectedConnectionId) {
          const connection = await tx.connections.findFirst({
            where: { id: selectedConnectionId, organization_id: actor.organizationId, status: "connected", revoked_at: null },
            select: { metadata: true },
          });
          const metadata = connection?.metadata && typeof connection.metadata === "object" && !Array.isArray(connection.metadata)
            ? connection.metadata as Record<string, unknown>
            : {};
          if (metadata.provider !== "github_app" || typeof metadata.repository_url !== "string" || !metadata.repository_url.trim()) {
            throw conflict("選択したGitHub Repository Connectionは現在利用できません");
          }
          if (!isOrganizationIntegrationRepository(metadata)) {
            throw conflict("企業専用ToolにはAgent Studio本体ではなく、企業専用Integration Repositoryを選択してください");
          }
          repositoryUrl = metadata.repository_url.trim();
          baseBranch = typeof metadata.base_branch === "string" && metadata.base_branch.trim() ? metadata.base_branch.trim() : "main";
        }
        const adapterPath = typeof automaticCondition.adapter_path === "string" ? automaticCondition.adapter_path.trim() : "";
        const interfaceNotes = answers.interface_notes?.trim()
          || (typeof automaticCondition.interface_notes === "string" ? automaticCondition.interface_notes.trim() : "")
          || inferCodeWorkspaceInterface(action.project.request, action.title);
        answers = {
          ...answers,
          ...(repositoryUrl ? { repository_url: repositoryUrl } : {}),
          ...(baseBranch ? { base_branch: baseBranch } : {}),
          ...(adapterPath ? { adapter_path: adapterPath } : {}),
          interface_notes: interfaceNotes,
        };
      }
      for (const name of ["source_url", "contract_url"]) {
        const value = answers[name]?.trim();
        if (!value) continue;
        try {
          const url = new URL(value);
          if (url.protocol !== "https:" || url.username || url.password || (name === "contract_url" && (url.search || url.hash))) throw new Error();
        } catch {
          throw validationError(`${name === "contract_url" ? "OpenAPIまたはMCP" : "参照先"}には認証情報を含まないHTTPS URLを入力してください`);
        }
      }
      const repositoryUrl = answers.repository_url?.trim();
      if (repositoryUrl) {
        try {
          const url = new URL(repositoryUrl);
          if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
        } catch {
          throw validationError("実装先Git Repositoryには認証情報・query・fragmentを含まないHTTPS URLを入力してください");
        }
      }
      if (actionTopic.startsWith("code_workspace:") && repositoryUrl && !answers.base_branch?.trim()) {
        const repositoryVariants = [repositoryUrl, repositoryUrl.endsWith(".git") ? repositoryUrl.slice(0, -4) : `${repositoryUrl}.git`];
        const gitConnection = await tx.connections.findFirst({
          where: {
            organization_id: actor.organizationId,
            status: "connected",
            revoked_at: null,
            OR: repositoryVariants.map((value) => ({ metadata: { path: ["repository_url"], equals: value } })),
          },
          orderBy: { last_validated_at: "desc" },
          select: { metadata: true },
        });
        const metadata = gitConnection?.metadata && typeof gitConnection.metadata === "object" && !Array.isArray(gitConnection.metadata)
          ? gitConnection.metadata as Record<string, unknown>
          : {};
        const detected = typeof metadata.base_branch === "string" && metadata.base_branch.trim() ? metadata.base_branch.trim() : "main";
        answers = { ...answers, base_branch: detected };
      }
      const baseBranch = answers.base_branch?.trim();
      if (baseBranch && (!/^[A-Za-z0-9._/-]+$/.test(baseBranch) || baseBranch.startsWith("/") || baseBranch.endsWith("/") || baseBranch.includes("//") || baseBranch.includes(".."))) {
        throw validationError("基点branchの形式が正しくありません");
      }
      const adapterPath = answers.adapter_path?.trim();
      if (adapterPath && (adapterPath.startsWith("/") || adapterPath.endsWith("/") || adapterPath.split("/").some((part) => !part || part === "." || part === ".."))) {
        throw validationError("生成先ディレクトリはRepositoryルートからの安全な相対パスで入力してください");
      }
      const missing = fields.flatMap((field) =>
        field.required !== false && typeof field.name === "string" && !answers[field.name]?.trim()
          ? [typeof field.label === "string" ? field.label : field.name]
          : [],
      );
      if (missing.length) throw validationError(`回答が必要です: ${missing.join("、")}`);
      const declaredRuntimeTool = answers.runtime_tool?.trim();
      if (declaredRuntimeTool) {
        const runtimeTool = await tx.tools.findFirst({
          where: {
            organization_id: actor.organizationId,
            name: declaredRuntimeTool,
            execution_location: "runtime_mcp",
          },
          select: { id: true },
        });
        if (!runtimeTool) throw conflict("RuntimeのHeartbeatで報告済みのToolを指定してください");
      }
      if (actionTopic === "compliance_source") {
        const accessMethod = answers.access_method?.trim();
        if (accessMethod === "runtime_tool") {
          const runtimeToolName = answers.runtime_tool?.trim();
          if (!runtimeToolName) throw validationError("許可済みRuntime Tool名を入力してください");
        } else if (accessMethod === "public_web" || accessMethod === "human_login") {
          if (!answers.source_url?.trim()) throw validationError("公開サイトを使う場合はサイトURLを入力してください");
        }
      }
      const condition = action.resume_condition as { type?: unknown; connector_id?: unknown };
      if ((condition.type === "connector_connected" || condition.type === "connection_status") && typeof condition.connector_id === "string") {
        const connected = await tx.connections.findFirst({
          where: { organization_id: actor.organizationId, connector_id: condition.connector_id, status: "connected", revoked_at: null },
          select: { id: true },
        });
        if (!connected) throw conflict("接続テストが成功したConnectionを先に準備してください");
      }
      const actionCondition = automaticCondition;
      const sourceTopic = typeof actionCondition.source_topic === "string" ? actionCondition.source_topic : actionTopic.replace(/^code_workspace:/, "");
      const normalizedAnswers = actionTopic === "compliance_source" && !answers.access_method?.trim()
        ? { ...answers, access_method: "public_web" }
        : answers;
      await tx.human_actions.update({
        where: { id: actionId },
        data: { status: "completed", response: normalizedAnswers, completed_by: actor.userId, completed_at: new Date() },
      });
      if (actionTopic === "compliance_source" || sourceTopic === "compliance_source") {
        const sourceUrl = answers.source_url?.trim();
        const searchKey = answers.search_key?.trim();
        const accessMethod = normalizedAnswers.access_method?.trim();
        if (sourceUrl && searchKey && (accessMethod === "public_web" || accessMethod === "human_login") && !answers.contract_url?.trim()) {
          const domain = new URL(sourceUrl).hostname.toLowerCase();
          const browserMode = accessMethod === "human_login" ? "authenticated_restricted" : "public_ephemeral";
          const sourceHash = requestHash(JSON.stringify({ sourceUrl, searchKey, browserMode }));
          const existing = await tx.builder_change_sets.findFirst({
            where: { project_id: action.project_id, kind: "browser_flow", source_hash: sourceHash },
            select: { id: true },
          });
          if (!existing) {
            const change = await tx.builder_change_sets.create({ data: {
              organization_id: actor.organizationId,
              project_id: action.project_id,
              kind: "browser_flow",
              status: "planned",
              summary: `${domain}だけを許可した反社照合Browser Flowを生成`,
              risk: "read",
              artifacts: [
                { type: "capability_topic", id: "compliance_source", name: "compliance_source" },
                { type: "allowed_domain", id: domain, name: domain },
                { type: "browser_mode", id: browserMode, name: browserMode },
                { type: "browser_step", id: "navigate", name: "指定URLを開く" },
                { type: "browser_step", id: "search", name: `${searchKey}で検索` },
                { type: "browser_step", id: "snapshot", name: "Snapshotで結果を確認" },
                { type: "browser_step", id: "extract", name: "一致有無・出典URL・取得時刻だけを返す" },
              ],
              source_hash: sourceHash,
            } });
            await tx.builder_validation_runs.create({ data: {
              organization_id: actor.organizationId,
              project_id: action.project_id,
              suite: "security",
              environment: "builder",
              status: "passed",
              evidence: {
                change_set_id: change.id,
                browser_mode: browserMode,
                allowed_domains: [domain],
                allow_public_web: false,
                code_execution_enabled: false,
                controls: ["exact_domain_allowlist", "private_ip_blocked", "prompt_injection_untrusted", "snapshot_evidence_required"],
              },
              finished_at: new Date(),
            } });
          }
          if (accessMethod === "human_login") {
            const loginAction = await tx.human_actions.findFirst({
              where: { project_id: action.project_id, type: "human_login", status: "pending" },
              select: { id: true },
            });
            if (!loginAction) await tx.human_actions.create({ data: {
              organization_id: actor.organizationId,
              project_id: action.project_id,
              type: "human_login",
              title: `${domain}へログインしてください`,
              reason: "MFA、CAPTCHA、規約同意をBuilder Agentが代行せず、暗号化Browser Profileへ人がログイン状態を保存するためです",
              assignee_role: "builder",
              fields: [],
              instructions: ["Browser Profileを開きます", "対象サイトへ人がログインします", "MFAやCAPTCHAを完了します", "ログイン状態の検証後にBuilderが自動再開します"],
              resume_condition: { type: "browser_profile_ready", domain, mode: browserMode },
            } });
          }
        }
      }
      if (actionTopic.startsWith("code_workspace:") && repositoryUrl && baseBranch && adapterPath) {
        const sequence = (await tx.builder_change_sets.count({ where: { project_id: action.project_id, kind: "code_workspace" } })) + 1;
        const branch = `builder/${action.project_id.slice(0, 8)}/${sourceTopic.replace(/_/g, "-")}/${sequence}`;
        const risk = sourceTopic === "public_x_post" ? "external_send" : "read";
        const sourceHash = requestHash(JSON.stringify({ sourceTopic, repositoryUrl, baseBranch, adapterPath, interfaceNotes: answers.interface_notes?.trim() ?? "" }));
        const existing = await tx.builder_change_sets.findFirst({
          where: { project_id: action.project_id, kind: "code_workspace", source_hash: sourceHash },
          select: { id: true },
        });
        if (!existing) {
          const change = await tx.builder_change_sets.create({ data: {
            organization_id: actor.organizationId,
            project_id: action.project_id,
            kind: "code_workspace",
            status: "planned",
            summary: `${action.title.replace(/(?:の実装先|の入出力)?を(?:教えて|確認して)ください$/, "")}を隔離branchで生成・テストしPR化`,
            risk,
            artifacts: [
              { type: "capability_topic", id: sourceTopic, name: sourceTopic },
              { type: "repository", id: repositoryUrl, name: repositoryUrl.replace(/^https:\/\//, "") },
              { type: "base_branch", id: baseBranch, name: baseBranch },
              { type: "git_branch", id: branch, name: branch },
              { type: "isolated_workspace", id: `builder-${action.project_id.slice(0, 8)}-${sourceTopic}`, name: "org/run専用workspace" },
              { type: "adapter_target", id: adapterPath, name: adapterPath },
            ],
            source_hash: sourceHash,
          } });
          await tx.builder_validation_runs.create({ data: {
            organization_id: actor.organizationId,
            project_id: action.project_id,
            suite: "security",
            environment: "builder",
            status: "passed",
            evidence: {
              change_set_id: change.id,
              capability_topic: sourceTopic,
              repository_url: repositoryUrl,
              base_branch: baseBranch,
              branch,
              adapter_path: adapterPath,
              controls: ["isolated_workspace", "dedicated_branch", "no_direct_main_push", "no_secret_in_prompt", "tests_required_before_pr"],
              secret_values_persisted: false,
              customer_data_persisted: false,
            },
            finished_at: new Date(),
          } });
        }
      }
      const remaining = await tx.human_actions.count({ where: { project_id: action.project_id, status: "pending" } });
      if (remaining === 0) {
        const last = await tx.builder_runs.aggregate({ where: { project_id: action.project_id }, _max: { attempt: true } });
        await this.enqueue(tx, actor.organizationId, action.project_id, action.project.request, (last._max.attempt ?? 0) + 1);
        await tx.builder_projects.update({ where: { id: action.project_id }, data: { status: "draft" } });
      }
      await recordAudit(
        tx,
        auditBy(actor, {
          action: "builder.human_action.complete",
          targetType: "human_action",
          targetId: actionId,
          detail: { project_id: action.project_id, automatically_resumed: remaining === 0, answered_fields: Object.keys(answers) },
        }),
      );
      const project = await tx.builder_projects.findUniqueOrThrow({ where: { id: action.project_id }, include: includeProject });
      return toBuilderProjectDto(project);
    });
  }

  /** 接続テスト成功をHuman Actionの完了条件として検知し、入力を求めずBuilderを再開する。 */
  async completeConnectionActions(actor: MemberActor, connection: ConnectionDto): Promise<void> {
    if (connection.status !== "connected" || !connection.connector_id) return;
    await this.deps.db.run(scopeOf(actor), async (tx) => {
      const candidates = await tx.human_actions.findMany({
        where: { organization_id: actor.organizationId, status: "pending", type: { in: ["enter_secret", "provider_app_registration", "oauth_consent"] } },
        include: { project: true },
      });
      const matches = candidates.filter((action) => {
        const condition = action.resume_condition as { type?: unknown; connector_id?: unknown };
        return (condition.type === "connector_connected" || condition.type === "connection_status") && condition.connector_id === connection.connector_id;
      });
      for (const action of matches) {
        await tx.human_actions.update({
          where: { id: action.id },
          data: { status: "completed", completed_by: actor.userId, completed_at: new Date() },
        });
        await tx.builder_validation_runs.create({
          data: {
            organization_id: actor.organizationId,
            project_id: action.project_id,
            suite: "smoke",
            environment: connection.scope === "runtime" ? "production" : "preview",
            status: "passed",
            evidence: { connection_id: connection.id, connector_id: connection.connector_id, scope: connection.scope, validated_at: connection.last_validated_at },
            finished_at: new Date(),
          },
        });
        const remaining = await tx.human_actions.count({ where: { project_id: action.project_id, status: "pending" } });
        const active = await tx.builder_runs.count({ where: { project_id: action.project_id, status: { in: ["queued", "running"] } } });
        if (remaining === 0 && active === 0) {
          const last = await tx.builder_runs.aggregate({ where: { project_id: action.project_id }, _max: { attempt: true } });
          await this.enqueue(tx, actor.organizationId, action.project_id, action.project.request, (last._max.attempt ?? 0) + 1);
          await tx.builder_projects.update({ where: { id: action.project_id }, data: { status: "draft" } });
        }
        await recordAudit(
          tx,
          auditBy(actor, {
            action: "builder.human_action.auto_complete",
            targetType: "human_action",
            targetId: action.id,
            detail: { project_id: action.project_id, connection_id: connection.id, connector_id: connection.connector_id },
          }),
        );
      }
    });
  }

  /** GitHub AppのRepository接続を検知し、実装先を再入力させずBuilderを再開する。 */
  async completeGitHubRepositoryActions(actor: MemberActor, connection: ConnectionDto): Promise<void> {
    if (connection.status !== "connected" || connection.metadata.provider !== "github_app") return;
    if (!isOrganizationIntegrationRepository(connection.metadata)) return;
    await this.deps.db.run(scopeOf(actor), async (tx) => {
      const candidates = await tx.human_actions.findMany({
        where: { organization_id: actor.organizationId, status: "pending", type: { in: ["provider_app_registration", "business_rule_confirmation"] } },
        include: { project: true },
      });
      for (const action of candidates) {
        const condition = action.resume_condition && typeof action.resume_condition === "object" && !Array.isArray(action.resume_condition)
          ? action.resume_condition as Record<string, unknown>
          : {};
        const legacyCoreSelection = typeof condition.topic === "string"
          && condition.topic.startsWith("code_workspace:")
          && typeof condition.repository_url === "string"
          && /github\.com\/[^/]+\/agent-studio(?:\.git)?$/i.test(condition.repository_url);
        if (legacyCoreSelection) {
          const label = typeof connection.metadata.owner === "string" && typeof connection.metadata.repository === "string"
            ? `${connection.metadata.owner}/${connection.metadata.repository}`
            : connection.name;
          await tx.human_actions.update({
            where: { id: action.id },
            data: {
              resume_condition: {
                ...condition,
                repository_connection_id: connection.id,
                repository_url: typeof connection.metadata.repository_url === "string" ? connection.metadata.repository_url : "",
                base_branch: typeof connection.metadata.base_branch === "string" ? connection.metadata.base_branch : "main",
              } as Prisma.InputJsonValue,
              instructions: [
                `接続済みの ${label} を企業専用Toolの実装先として自動選択しました`,
                "作業用の保存先とbranchは自動設定します",
                "元のコードを直接変更せず、専用branchで作業します",
                "テストと安全検査に合格した変更だけをレビュー候補にします",
              ],
            },
          });
          await recordAudit(tx, auditBy(actor, {
            action: "builder.github_repository.retarget",
            targetType: "human_action",
            targetId: action.id,
            detail: { project_id: action.project_id, connection_id: connection.id, replaced_agent_studio_core: true },
          }));
          continue;
        }
        if (condition.type !== "github_repository_connected") continue;
        await tx.human_actions.update({
          where: { id: action.id },
          data: {
            status: "completed",
            response: { repository_connection_id: connection.id },
            completed_by: actor.userId,
            completed_at: new Date(),
          },
        });
        await tx.builder_validation_runs.create({
          data: {
            organization_id: actor.organizationId,
            project_id: action.project_id,
            suite: "smoke",
            environment: "builder",
            status: "passed",
            evidence: {
              connection_id: connection.id,
              provider: "github_app",
              repository_url: typeof connection.metadata.repository_url === "string" ? connection.metadata.repository_url : "",
              base_branch: typeof connection.metadata.base_branch === "string" ? connection.metadata.base_branch : "main",
              validated_at: connection.last_validated_at,
            },
            finished_at: new Date(),
          },
        });
        const remaining = await tx.human_actions.count({ where: { project_id: action.project_id, status: "pending" } });
        const active = await tx.builder_runs.count({ where: { project_id: action.project_id, status: { in: ["queued", "running"] } } });
        if (remaining === 0 && active === 0) {
          const last = await tx.builder_runs.aggregate({ where: { project_id: action.project_id }, _max: { attempt: true } });
          await this.enqueue(tx, actor.organizationId, action.project_id, action.project.request, (last._max.attempt ?? 0) + 1);
          await tx.builder_projects.update({ where: { id: action.project_id }, data: { status: "draft" } });
        }
        await recordAudit(
          tx,
          auditBy(actor, {
            action: "builder.github_repository.auto_complete",
            targetType: "human_action",
            targetId: action.id,
            detail: { project_id: action.project_id, connection_id: connection.id },
          }),
        );
      }
    });
  }

  async cancel(actor: MemberActor, id: string): Promise<BuilderProjectDto> {
    requireRole(actor, "builder");
    await this.deps.db.run(scopeOf(actor), async (tx) => {
      const project = await tx.builder_projects.findFirst({ where: { id, organization_id: actor.organizationId } });
      if (!project) throw notFound("作成プロジェクト");
      const activeReleases = await tx.builder_releases.findMany({
        where: { project_id: id, status: "preview_running", preview_run_id: { not: null } },
      });
      for (const release of activeReleases) {
        const previewRun = await tx.runs.findUnique({ where: { id: release.preview_run_id! } });
        if (previewRun && !["completed", "failed", "cancelled"].includes(previewRun.status)) {
          await setRunStatus(tx, previewRun, "cancelled", {}, "Builder Projectが中止されました");
        }
        await tx.builder_releases.update({ where: { id: release.id }, data: { status: "preview_cancelled", finished_at: new Date() } });
      }
      if (activeReleases.length > 0) {
        await tx.builder_validation_runs.updateMany({
          where: { project_id: id, suite: "preview", status: "running" },
          data: { status: "blocked", error_class: "cancelled", error: "Builder Projectが中止されました", finished_at: new Date() },
        });
      }
      await tx.builder_projects.update({ where: { id }, data: { status: "cancelled" } });
      await tx.builder_runs.updateMany({ where: { project_id: id, status: { in: ["queued", "running", "waiting_human_action"] } }, data: { status: "cancelled", finished_at: new Date() } });
      await recordAudit(tx, auditBy(actor, { action: "builder.project.cancel", targetType: "builder_project", targetId: id, detail: { preview_run_ids: activeReleases.flatMap((release) => release.preview_run_id ? [release.preview_run_id] : []) } }));
    });
    return this.get(actor, id);
  }

  /** Previewで固定した同一Buildを、管理者承認後にProductionへ昇格し限定Runを開始する。 */
  async approveProduction(actor: MemberActor, id: string, automatic?: AutomaticProductionApproval): Promise<BuilderProjectDto> {
    requireRole(actor, "admin");
    const candidate = await this.deps.db.run(scopeOf(actor), async (tx) => {
      const project = await tx.builder_projects.findFirst({ where: { id, organization_id: actor.organizationId } });
      if (!project) throw notFound("作成プロジェクト");
      if (project.target !== "production") throw conflict("Productionを対象にした作成プロジェクトではありません");
      const release = await tx.builder_releases.findFirst({
        where: { project_id: id, status: "production_pending_approval" },
        orderBy: { created_at: "desc" },
      });
      if (!release) throw conflict("承認待ちのProduction候補がありません");
      const action = await tx.human_actions.findFirst({ where: { project_id: id, type: "production_approval", status: "pending" } });
      if (!action) throw conflict("Production承認操作が見つかりません");
      const previewRun = release.preview_run_id
        ? await tx.runs.findFirst({ where: { id: release.preview_run_id, organization_id: actor.organizationId } })
        : null;
      if (!previewRun?.input.trim()) throw conflict("Previewで成功した代表入力が見つかりません");

      const previous = await tx.deployments.findFirst({
        where: { organization_id: actor.organizationId, agent_id: release.agent_id, stage: "production", status: "active" },
        orderBy: { created_at: "desc" },
      });
      const stagingLinks = await tx.agent_connection_links.findMany({
        where: { organization_id: actor.organizationId, agent_id: release.agent_id, stage: "staging" },
      });
      for (const link of stagingLinks) {
        await tx.agent_connection_links.upsert({
          where: { agent_id_stage_connector_id: { agent_id: release.agent_id, stage: "production", connector_id: link.connector_id } },
          create: {
            organization_id: actor.organizationId,
            agent_id: release.agent_id,
            connector_id: link.connector_id,
            connection_id: link.connection_id,
            stage: "production",
            allowed_capabilities: link.allowed_capabilities as Prisma.InputJsonValue,
            created_by: actor.userId,
          },
          update: { connection_id: link.connection_id, allowed_capabilities: link.allowed_capabilities as Prisma.InputJsonValue, created_by: actor.userId },
        });
      }
      const stagingVariables = await tx.agent_environment_configs.findUnique({ where: { agent_id_stage: { agent_id: release.agent_id, stage: "staging" } } });
      if (stagingVariables) {
        await tx.agent_environment_configs.upsert({
          where: { agent_id_stage: { agent_id: release.agent_id, stage: "production" } },
          create: { organization_id: actor.organizationId, agent_id: release.agent_id, stage: "production", variables: stagingVariables.variables as Prisma.InputJsonValue },
          update: { variables: stagingVariables.variables as Prisma.InputJsonValue },
        });
      }
      return { release, action, previousId: previous?.id ?? null, previewInput: previewRun.input.trim() };
    });

    const production = await this.environments.promote(actor, candidate.release.preview_deployment_id);
    if (production.build_id !== candidate.release.build_id) throw conflict("Previewと異なるBuildがProductionへ昇格されました");
    const toolName = candidate.release.required_tools[0];
    const testCall = this.deps.env.NODE_ENV === "test" && toolName ? `\n[[call:${toolName} {}]]` : "";
    const run = await this.runs.create(actor, {
      deployment_id: production.id,
      input: `Builder AgentのProduction限定確認です。Previewで成功した次の代表入力を、同じ条件で1回だけ再実行してください。結果を日本語で簡潔に報告し、書き込みや外部送信は行わないでください。\n\n${candidate.previewInput}${testCall}`,
    });
    await this.deps.db.run(scopeOf(actor), async (tx) => {
      await tx.builder_releases.update({
        where: { id: candidate.release.id },
        data: {
          status: "production_running",
          production_deployment_id: production.id,
          production_run_id: run.id,
          rollback_target_deployment_id: candidate.previousId,
        },
      });
      await tx.human_actions.update({
        where: { id: candidate.action.id },
        data: { status: "completed", completed_by: automatic ? null : actor.userId, completed_at: new Date() },
      });
      await tx.builder_validation_runs.create({
        data: {
          organization_id: actor.organizationId,
          project_id: id,
          suite: "preview",
          environment: "production",
          status: "running",
          evidence: { release_id: candidate.release.id, deployment_id: production.id, run_id: run.id, build_id: production.build_id, config_hash: candidate.release.config_hash, limited_run: true },
        },
      });
      await tx.builder_projects.update({ where: { id }, data: { status: "validating" } });
      if (automatic) {
        await tx.approvals.update({
          where: { id: automatic.approvalId },
          data: { status: "consumed", consumed_at: new Date() },
        });
        await recordAudit(tx, {
          organizationId: actor.organizationId,
          actorType: "system",
          actorId: automatic.policyId,
          actorLabel: "Organization Policy",
          sourceIp: null,
          action: "builder.production.auto_promote",
          targetType: "builder_release",
          targetId: candidate.release.id,
          detail: {
            project_id: id,
            build_id: production.build_id,
            deployment_id: production.id,
            run_id: run.id,
            same_build: true,
            approval_id: automatic.approvalId,
            policy_id: automatic.policyId,
            policy_version: automatic.policyVersion,
            reason: automatic.reason,
          },
        });
      } else {
        await recordAudit(tx, auditBy(actor, {
          action: "builder.production.approve",
          targetType: "builder_release",
          targetId: candidate.release.id,
          detail: { project_id: id, build_id: production.build_id, deployment_id: production.id, run_id: run.id, same_build: true },
        }));
      }
    });
    return this.get(actor, id);
  }

  /** 顧客AWS向けSelf-hosted Runtimeの安全なPlanを固定する。apply自体は管理者操作として分離する。 */
  async prepareSelfHosted(actor: MemberActor, id: string, input: CreateRuntimeInput): Promise<BuilderProjectDto> {
    requireRole(actor, "admin");
    const project = await this.deps.db.run(scopeOf(actor), (tx) => tx.builder_projects.findFirst({ where: { id, organization_id: actor.organizationId } }));
    if (!project) throw notFound("作成プロジェクト");
    const runtime = await this.environments.createRuntime(actor, input);
    await this.deps.db.run(scopeOf(actor), async (tx) => {
      await tx.builder_change_sets.create({ data: {
        organization_id: actor.organizationId,
        project_id: id,
        kind: "terraform_plan",
        status: "planned",
        summary: `${input.aws_account_id}/${input.aws_region}へSelf-hosted Runtimeを構成`,
        risk: "write",
        artifacts: [
          { type: "runtime", id: runtime.id, name: runtime.name },
          { type: "terraform_module", id: "infra/modules/tenant-runtime", name: "tenant-runtime" },
          { type: "terraform_root", id: `infra/company/<customer>/${input.stage}`, name: `${input.stage} root` },
        ],
        source_hash: requestHash(JSON.stringify({ account: input.aws_account_id, region: input.aws_region, role: input.expected_role_name, stage: input.stage })),
      } });
      await tx.builder_validation_runs.create({ data: {
        organization_id: actor.organizationId,
        project_id: id,
        suite: "security",
        environment: "builder",
        status: "passed",
        evidence: {
          runtime_id: runtime.id,
          plan_only: true,
          customer_owned: input.provisioning_type === "customer_owned",
          secret_values_persisted: false,
          controls: ["private_subnet", "kms_secrets", "least_privilege_role", "bootstrap_token_one_time"],
        },
        finished_at: new Date(),
      } });
      await tx.human_actions.create({ data: {
        organization_id: actor.organizationId,
        project_id: id,
        type: "aws_admin_action",
        title: "Terraform Planを確認して顧客AWSへapply",
        reason: "VPC・DNS・IAM・Secret作成は顧客AWS管理者の承認が必要です",
        assignee_role: "admin",
        fields: [],
        instructions: [
          "リリース候補のcommit SHAとTerraform Planを確認します",
          "Runtime画面で一度限りのBootstrap Tokenを発行し、顧客AWSのSecrets Managerへ入力します",
          "承認済みPlanをapplyし、Runtime Controllerの登録とheartbeatを待ちます",
        ],
        resume_condition: { type: "runtime_active", runtime_id: runtime.id },
      } });
      await tx.builder_projects.update({ where: { id }, data: { status: "waiting_human_action" } });
      await recordAudit(tx, auditBy(actor, { action: "builder.self_hosted.plan", targetType: "builder_project", targetId: id, detail: { runtime_id: runtime.id, aws_account_id: input.aws_account_id, region: input.aws_region, plan_only: true } }));
    });
    return this.get(actor, id);
  }

  private async enqueue(tx: Prisma.TransactionClient, organizationId: string, projectId: string, request: string, attempt: number) {
    await tx.builder_runs.create({
      data: {
        organization_id: organizationId,
        project_id: projectId,
        attempt,
        correlation_id: randomUUID(),
        budget: {
          max_attempts: 3,
          phase: "planning",
          ...(this.deps.env.NODE_ENV === "test" ? { worker_id: this.deps.env.WORKER_ID } : {}),
        },
        steps: {
          create: [
            { kind: "analyze_requirements", input_hash: requestHash(request) },
            { kind: "resolve_capabilities", input_hash: requestHash(`${request}:resolve`) },
            { kind: "prepare_human_actions", input_hash: requestHash(`${request}:human`) },
          ],
        },
      },
    });
  }

  private async createAgentShell(tx: Prisma.TransactionClient, actor: MemberActor, request: string): Promise<string> {
    const id = randomUUID();
    const name = shellName(request);
    await tx.agents.create({
      data: {
        id,
        organization_id: actor.organizationId,
        key: `agent-${id.slice(0, 8)}`,
        name,
        description: "作成内容を整理しています",
        project_brief: request,
        capability_resolution: {
          requirements: [],
          selected_tools: [],
          missing_variables: [],
          ready: false,
        },
        created_by: actor.userId,
        environment_configs: {
          create: [
            { stage: "staging", variables: {} },
            { stage: "production", variables: {} },
          ],
        },
      },
    });
    return id;
  }

  private async ensureProjectAgent(
    tx: Prisma.TransactionClient,
    actor: MemberActor,
    project: { id: string; request: string; agent_id: string | null },
  ): Promise<string> {
    if (project.agent_id) return project.agent_id;
    const release = await tx.builder_releases.findFirst({
      where: { organization_id: actor.organizationId, project_id: project.id },
      orderBy: { created_at: "desc" },
      select: { agent_id: true },
    });
    const agentId = release?.agent_id ?? await this.createAgentShell(tx, actor, project.request);
    await tx.builder_projects.update({ where: { id: project.id }, data: { agent_id: agentId } });
    await recordAudit(tx, auditBy(actor, {
      action: "builder.project.agent_backfill",
      targetType: "builder_project",
      targetId: project.id,
      detail: { agent_id: agentId, source: release ? "release" : "shell" },
    }));
    return agentId;
  }
}
