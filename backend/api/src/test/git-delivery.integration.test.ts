import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, type GitHubAppConnectionMetadata, type HeartbeatRequest } from "@agent-studio/contracts";
import { RuntimeApiService } from "../application/runtime-api.js";
import type { GitHubAppSecret, GitProvider } from "../infrastructure/git/github-app.js";
import { createHarness, type Harness } from "./harness.js";
import { adapterAttestationPayload } from "../infrastructure/git/adapter-signature.js";

const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const mergeSha = "c".repeat(40);
const webhookSecret = "integration-webhook-secret";
const packageSigningKeys = generateKeyPairSync("ed25519");
const packageSigningPublicKey = packageSigningKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
let mergeRequested = false;

const fakeGit: GitProvider = {
  async createInstallationToken() { return { token: "installation-token-1234567890", expiresAt: "2099-01-01T00:00:00.000Z" }; },
  async provisionOrganizationRepository(input) { return { id: 999, full_name: `${input.metadata.owner}/${input.name}`, default_branch: "main", private: true }; },
  async validateRepository(metadata) { return { id: Number(metadata.repository_id), full_name: `${metadata.owner}/${metadata.repository}`, default_branch: "develop" }; },
  async createOrUpdatePullRequest(input) {
    return { number: 17, html_url: "https://github.example/pull/17", state: "open", merged: false, merge_commit_sha: null, head: { sha: input.headSha, ref: input.branch }, base: { sha: input.baseSha, ref: input.metadata.base_branch } };
  },
  async getPullRequest(_metadata: GitHubAppConnectionMetadata, _secret: GitHubAppSecret, number: number) {
    return { number, html_url: `https://github.example/pull/${number}`, state: mergeRequested ? "closed" : "open", merged: mergeRequested, merge_commit_sha: mergeRequested ? mergeSha : null, head: { sha: headSha, ref: "builder/agent/check/1" }, base: { sha: baseSha, ref: "develop" } };
  },
  async getRequiredChecks() { return { complete: false, successful: false, checks: [] }; },
  async mergePullRequest() {
    mergeRequested = true;
    return { merged: true, message: "Pull Request successfully merged", sha: mergeSha };
  },
};

describe("GitHub App → signed Adapter delivery", () => {
  let h: Harness;
  let orgId: string;
  let runtimeId: string;
  let projectId: string;
  let changeSetId: string;
  let connectionId: string;
  let service: RuntimeApiService;

  beforeAll(async () => {
    h = createHarness({ gitProvider: fakeGit });
    const org = await h.createOrg("git-delivery", [{ email: "owner-git@example.com", role: "owner", approver: true }]);
    orgId = org.id;
    const runtime = await h.admin.runtimes.create({ data: {
      organization_id: orgId, name: "Preview Runtime", stage: "staging", provisioning_type: "customer_owned",
      aws_account_id: `9${h.suffix.padEnd(11, "0")}`.slice(0, 12), aws_region: "ap-northeast-1", expected_role_name: `runtime-${h.suffix}`, status: "active",
    } });
    runtimeId = runtime.id;
    const agent = await h.admin.agents.create({ data: { organization_id: orgId, key: `factoring-${h.suffix}`, name: "Factoring Agent" } });
    const project = await h.admin.builder_projects.create({ data: { organization_id: orgId, agent_id: agent.id, request: "fixtureで審査", status: "running" } });
    projectId = project.id;
    const change = await h.admin.builder_change_sets.create({ data: {
      organization_id: orgId, project_id: project.id, kind: "code_workspace", status: "applied", summary: "審査Adapter", risk: "read",
      base_sha: baseSha, head_sha: headSha,
      artifacts: [
        { type: "repository", id: "https://github.com/example/private-adapters.git" },
        { type: "base_branch", id: "develop" },
        { type: "git_branch", id: "builder/agent/check/1" },
        { type: "diff", id: "d".repeat(64) },
        { type: "changed_file", id: "runtime/adapters/factoring/index.ts" },
      ],
    } });
    changeSetId = change.id;
    const created = await h.request("POST", "/api/v1/connections/github-app", {
      email: "owner-git@example.com", org: orgId,
      body: {
        name: "Private adapter repository", app_id: "100", private_key: "-----BEGIN PRIVATE KEY-----\n" + "x".repeat(120) + "\n-----END PRIVATE KEY-----",
        webhook_secret: webhookSecret, installation_id: "200", repository_id: "300", owner: "example", repository: "private-adapters",
        package_signing_public_key: packageSigningPublicKey,
        permissions: { contents: "write", pull_requests: "write", checks: "read", metadata: "read" },
      },
    });
    expect(created.status).toBe(201);
    expect(created.body).not.toHaveProperty("private_key");
    expect(created.body.metadata).toMatchObject({ provider: "github_app", repository_id: "300", base_branch: "develop" });
    connectionId = created.body.id;
    const genericOverwrite = await h.request("PUT", `/api/v1/connections/${connectionId}/secret`, {
      email: "owner-git@example.com", org: orgId, body: { value: "must-not-replace-github-app-json" },
    });
    expect(genericOverwrite.status).toBe(400);
    service = new RuntimeApiService(h.deps);
  });

  afterAll(async () => h.close());

  it("既存GitHub Appから会社専用private Repositoryを自動作成してConnectionへ登録する", async () => {
    const provisioned = await h.request("POST", `/api/v1/connections/${connectionId}/integration-repository`, {
      email: "owner-git@example.com",
      org: orgId,
      body: {},
    });
    expect(provisioned.status, JSON.stringify(provisioned.body)).toBe(201);
    expect(provisioned.body).toMatchObject({
      status: "connected",
      metadata: {
        repository_id: "999",
        repository_purpose: "organization_integrations",
        base_branch: "main",
      },
    });
    expect(provisioned.body.metadata.repository).toMatch(/^agent-studio-git-delivery-.+-tools$/);
    expect(provisioned.body).not.toHaveProperty("private_key");
  });

  it("接続済みRepositoryからURL・default branch・生成先・専用branchを自動決定する", async () => {
    const project = await h.admin.builder_projects.create({ data: {
      organization_id: orgId,
      request: "社内DB用Adapterを作る",
      status: "waiting_human_action",
    } });
    const action = await h.admin.human_actions.create({ data: {
      organization_id: orgId,
      project_id: project.id,
      type: "business_rule_confirmation",
      title: "社内システム用Toolの実装先を確認してください",
      reason: "企業専用Runtimeで実行するため",
      assignee_role: "builder",
      fields: [
        { name: "repository_connection_id", label: "Repository", secret: false, required: true, options: [{ value: connectionId, label: "example/private-adapters" }] },
      ],
      instructions: [],
      resume_condition: {
        type: "builder_answers",
        topic: "code_workspace:organization_contracts",
        source_topic: "organization_contracts",
        adapter_path: "integrations/contracts",
        interface_notes: "契約IDで検索し、要約に必要な項目だけを取得する。登録・更新はしない。",
      },
    } });
    const completed = await h.request("POST", `/api/v1/builder-human-actions/${action.id}/complete`, {
      email: "owner-git@example.com",
      org: orgId,
      body: { answers: {
        repository_connection_id: connectionId,
      } },
    });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    const change = await h.admin.builder_change_sets.findFirstOrThrow({ where: { project_id: project.id, kind: "code_workspace" } });
    expect(change.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "repository", id: "https://github.com/example/private-adapters.git" }),
      expect.objectContaining({ type: "base_branch", id: "develop" }),
      expect.objectContaining({ type: "adapter_target", id: "integrations/contracts" }),
      expect.objectContaining({ type: "git_branch", id: expect.stringMatching(new RegExp(`^builder/${project.id.slice(0, 8)}/organization-contracts/1$`)) }),
    ]));
  });

  it("GitHub Repositoryの接続成功を検知してBuilderを自動再開する", async () => {
    const project = await h.admin.builder_projects.create({ data: {
      organization_id: orgId,
      request: "社内API用Toolを作る",
      status: "waiting_human_action",
    } });
    const action = await h.admin.human_actions.create({ data: {
      organization_id: orgId,
      project_id: project.id,
      type: "provider_app_registration",
      title: "GitHub Repositoryを接続してください",
      reason: "企業専用Toolを実装するため",
      assignee_role: "admin",
      fields: [],
      instructions: [],
      resume_condition: { type: "github_repository_connected" },
    } });
    const legacyProject = await h.admin.builder_projects.create({ data: {
      organization_id: orgId,
      request: "旧データの社内API用Toolを作る",
      status: "waiting_human_action",
    } });
    const legacyAction = await h.admin.human_actions.create({ data: {
      organization_id: orgId,
      project_id: legacyProject.id,
      type: "business_rule_confirmation",
      title: "社内システム用Toolの実装先を確認してください",
      reason: "企業専用Runtimeで実行するため",
      assignee_role: "builder",
      fields: [],
      instructions: ["接続済みの example/agent-studio を実装先として自動選択しました"],
      resume_condition: {
        type: "builder_answers",
        topic: "code_workspace:organization_legacy",
        repository_url: "https://github.com/example/agent-studio.git",
        base_branch: "main",
        adapter_path: "integrations/company-legacy",
      },
    } });

    const created = await h.request("POST", "/api/v1/connections/github-app", {
      email: "owner-git@example.com",
      org: orgId,
      body: {
        name: "Second adapter repository", app_id: "100", private_key: "-----BEGIN PRIVATE KEY-----\n" + "x".repeat(120) + "\n-----END PRIVATE KEY-----",
        webhook_secret: webhookSecret, installation_id: "200", repository_id: "301", owner: "example", repository: "second-adapters",
        package_signing_public_key: packageSigningPublicKey,
        permissions: { contents: "write", pull_requests: "write", checks: "read", metadata: "read" },
      },
    });

    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(await h.admin.human_actions.findUniqueOrThrow({ where: { id: action.id } })).toMatchObject({
      status: "completed",
      response: { repository_connection_id: created.body.id },
    });
    expect(await h.admin.human_actions.findUniqueOrThrow({ where: { id: legacyAction.id } })).toMatchObject({
      status: "pending",
      resume_condition: {
        repository_connection_id: created.body.id,
        repository_url: "https://github.com/example/second-adapters.git",
        base_branch: "develop",
      },
    });
    expect(await h.admin.builder_runs.count({ where: { project_id: project.id } })).toBe(1);
  });

  it("一回限りのrepository限定資格情報でpushし、同じChange SetのPRを固定する", async () => {
    const job = await h.admin.runtime_jobs.create({ data: {
      organization_id: orgId, runtime_id: runtimeId, type: "publish_builder_branch", status: "leased",
      payload: { type: "publish_builder_branch", project_id: projectId, change_set_id: changeSetId, connection_id: connectionId, repository_url: "https://github.com/example/private-adapters.git", base_branch: "main", branch: "builder/agent/check/1", base_sha: baseSha, commit_sha: headSha },
    } });
    const ctx = { runtimeId, organizationId: orgId, sourceIp: "127.0.0.1" };
    await expect(service.gitCredential(ctx, job.id)).resolves.toMatchObject({ token: "installation-token-1234567890", repository_url: "https://github.com/example/private-adapters.git" });
    await expect(service.gitCredential(ctx, job.id)).rejects.toMatchObject({ code: "git_credential_unavailable" });
    await service.jobResult(ctx, job.id, { status: "succeeded", output: { change_set_id: changeSetId, branch: "builder/agent/check/1", base_sha: baseSha, head_sha: headSha, remote_ref: "refs/heads/builder/agent/check/1" } });
    const change = await h.admin.builder_change_sets.findUniqueOrThrow({ where: { id: changeSetId } });
    expect(change).toMatchObject({ status: "pr_open", pr_number: 17, pr_url: "https://github.example/pull/17", head_sha: headSha, base_sha: baseSha });
    expect(await h.admin.human_actions.count({ where: { project_id: projectId, type: "repository_merge", status: "pending" } })).toBe(1);
  });

  it("GitHub Checksが未導入の新規Repositoryでも同一head SHAのBuilder検証後に自動mergeする", async () => {
    await h.admin.builder_validation_runs.create({ data: {
      organization_id: orgId,
      project_id: projectId,
      suite: "builder_session",
      environment: "builder",
      status: "passed",
      evidence: { change_set_id: changeSetId, commit_sha: headSha, tests: [{ command: "unit", status: "passed", exit_code: 0 }] },
      finished_at: new Date(),
    } });
    const action = await h.admin.human_actions.findFirstOrThrow({ where: { project_id: projectId, type: "repository_merge", status: "pending" } });
    const completed = await h.request("POST", `/api/v1/builder-human-actions/${action.id}/complete`, {
      email: "owner-git@example.com",
      org: orgId,
      body: { answers: {} },
    });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    expect(await h.admin.human_actions.findUniqueOrThrow({ where: { id: action.id } })).toMatchObject({
      status: "completed",
      response: { merge_requested: "true", merge_sha: mergeSha },
    });
    expect(await h.admin.builder_change_sets.findUniqueOrThrow({ where: { id: changeSetId } })).toMatchObject({
      status: "merged",
      merge_sha: mergeSha,
    });
    expect(await h.admin.human_actions.count({ where: { project_id: projectId, type: "adapter_delivery", status: "pending" } })).toBe(1);
    expect(mergeRequested).toBe(true);
  });

  it("署名済みmerge/deployment webhookとheartbeat一致後だけTool Versionを登録する", async () => {
    const sendWebhook = async (delivery: string, event: string, payload: unknown) => {
      const raw = JSON.stringify(payload);
      return h.app.request("/webhooks/github", { method: "POST", headers: {
        "content-type": "application/json", "x-github-delivery": delivery, "x-github-event": event,
        "x-hub-signature-256": `sha256=${createHmac("sha256", webhookSecret).update(raw).digest("hex")}`,
      }, body: raw });
    };
    const merged = await sendWebhook("delivery-merge", "pull_request", { action: "closed", number: 17, repository: { id: 300 }, pull_request: { merged: true } });
    expect(merged.status).toBe(202);
    expect((await h.admin.builder_change_sets.findUniqueOrThrow({ where: { id: changeSetId } })).merge_sha).toBe(mergeSha);

    const descriptor = {
      version: 1 as const,
      connector: { key: "factoring-adapter", display_name: "Factoring Adapter", description: "fixture data only" },
      tools: [{ name: "evaluate_factoring_rules", description: "deterministic rules", risk: "financial" as const, input_schema: { type: "object" as const, properties: {}, additionalProperties: false }, output_schema: { type: "object" } }],
      execution: { kind: "mcp" as const, health_endpoint: "/health" },
      network: { outbound_domains: [], private_network_required: true },
      required_connections: [{ kind: "runtime_secret", description: "fixture DB read-only" }],
      source: { repository: "example/private-adapters", merge_commit: mergeSha, build_context: "runtime/adapters/factoring" },
    };
    const descriptorHash = createHash("sha256").update(canonicalJson(descriptor)).digest("hex");
    const contractHash = createHash("sha256").update(canonicalJson(descriptor.tools)).digest("hex");
    const imageDigest = `sha256:${"e".repeat(64)}`;
    const sbomDigest = `sha256:${"f".repeat(64)}`;
    const packageSignature = sign(null, adapterAttestationPayload({
      source_commit: mergeSha, descriptor_hash: descriptorHash, contract_hash: contractHash, image_digest: imageDigest, sbom_digest: sbomDigest,
    }), packageSigningKeys.privateKey).toString("base64");
    const deployed = await sendWebhook("delivery-deploy", "deployment_status", {
      repository: { id: 300 },
      deployment_status: { state: "success" },
      deployment: { environment: "preview", ref: mergeSha, payload: { agent_studio: {
        change_set_id: changeSetId, runtime_id: runtimeId, connector_key: "factoring-adapter", descriptor_hash: descriptorHash,
        contract_hash: contractHash, image_digest: imageDigest, package_signature: packageSignature, sbom_digest: sbomDigest,
        dependency_scan: { status: "passed", critical: 0 }, secret_scan: { status: "passed", findings: 0 },
        provenance: { builder: "github-actions", source_repository: "example/private-adapters", build_context: "runtime/adapters/factoring" }, descriptor,
      } } },
    });
    expect(deployed.status).toBe(202);

    const heartbeat: HeartbeatRequest = {
      controller_version: "test", gateway_url: "http://127.0.0.1:8080/mcp", active_sessions: [], capabilities: ["adapter_delivery"],
      tools: [{
        name: "evaluate_factoring_rules", description: "deterministic rules", input_schema: { type: "object", properties: {}, additionalProperties: false }, risk: "financial", reads_untrusted_content: false,
        delivery: { connector_key: "factoring-adapter", contract_hash: contractHash, image_digest: imageDigest, source_commit: mergeSha, package_signature: packageSignature },
      }],
    };
    await service.heartbeat({ runtimeId, organizationId: orgId, sourceIp: "127.0.0.1" }, heartbeat);
    const pkg = await h.admin.builder_adapter_packages.findUniqueOrThrow({ where: { change_set_id: changeSetId } });
    expect(pkg).toMatchObject({ status: "registered", health_status: "ready", source_commit: mergeSha, image_digest: imageDigest });
    const connector = await h.admin.connectors.findUniqueOrThrow({ where: { organization_id_key: { organization_id: orgId, key: "factoring-adapter" } } });
    const tool = await h.admin.tools.findUniqueOrThrow({ where: { organization_id_name: { organization_id: orgId, name: "evaluate_factoring_rules" } } });
    expect(tool.connector_id).toBe(connector.id);
    expect(await h.admin.human_actions.count({ where: { project_id: projectId, type: "adapter_delivery", status: "pending" } })).toBe(0);
    const builderRunsAfterRegistration = await h.admin.builder_runs.count({ where: { project_id: projectId } });
    const validationsAfterRegistration = await h.admin.builder_validation_runs.count({ where: { project_id: projectId, suite: "tool_catalog" } });
    await service.heartbeat({ runtimeId, organizationId: orgId, sourceIp: "127.0.0.1" }, heartbeat);
    expect(await h.admin.builder_runs.count({ where: { project_id: projectId } })).toBe(builderRunsAfterRegistration);
    expect(await h.admin.builder_validation_runs.count({ where: { project_id: projectId, suite: "tool_catalog" } })).toBe(validationsAfterRegistration);
  });

  it("組織Policy内ならPR作成後にRequired Checksを固定して自動mergeする", async () => {
    mergeRequested = false;
    const project = await h.admin.builder_projects.create({ data: {
      organization_id: orgId,
      request: "許可済みの企業専用Adapterを自動反映する",
      status: "implementing",
    } });
    const change = await h.admin.builder_change_sets.create({ data: {
      organization_id: orgId,
      project_id: project.id,
      kind: "code_workspace",
      status: "applied",
      summary: "許可済みAdapter",
      risk: "read",
      base_sha: baseSha,
      head_sha: headSha,
      artifacts: [
        { type: "repository", id: "https://github.com/example/private-adapters.git" },
        { type: "base_branch", id: "develop" },
        { type: "git_branch", id: "builder/agent/check/1" },
        { type: "diff", id: "d".repeat(64) },
      ],
    } });
    await h.admin.builder_validation_runs.create({ data: {
      organization_id: orgId,
      project_id: project.id,
      suite: "builder_session",
      environment: "builder",
      status: "passed",
      evidence: { change_set_id: change.id, commit_sha: headSha, tests: [{ command: "unit", status: "passed", exit_code: 0 }] },
      finished_at: new Date(),
    } });
    const policy = await h.request("PUT", "/api/v1/organization/auto-approval-policy", {
      email: "owner-git@example.com",
      org: orgId,
      body: {
        mode: "all_within_policy",
        environments: ["staging"],
        allowed_hosts: [],
        allowed_operations: ["pull_request_merge"],
        allowed_methods: ["GET"],
        denied_methods: ["DELETE"],
        limits: { requests_per_minute: 100, daily_cost_jpy: null, max_records_per_call: 100 },
        production_promotion: false,
        automatic_retry: true,
        automatic_rollback: true,
        expires_at: null,
      },
    });
    expect(policy.status, JSON.stringify(policy.body)).toBe(200);
    const job = await h.admin.runtime_jobs.create({ data: {
      organization_id: orgId,
      runtime_id: runtimeId,
      type: "publish_builder_branch",
      status: "leased",
      payload: { type: "publish_builder_branch", project_id: project.id, change_set_id: change.id, connection_id: connectionId, repository_url: "https://github.com/example/private-adapters.git", base_branch: "develop", branch: "builder/agent/check/1", base_sha: baseSha, commit_sha: headSha },
    } });
    await service.jobResult(
      { runtimeId, organizationId: orgId, sourceIp: "127.0.0.1" },
      job.id,
      { status: "succeeded", output: { change_set_id: change.id, branch: "builder/agent/check/1", base_sha: baseSha, head_sha: headSha, remote_ref: "refs/heads/builder/agent/check/1" } },
    );
    expect(await h.admin.builder_change_sets.findUniqueOrThrow({ where: { id: change.id } })).toMatchObject({ status: "merged", merge_sha: mergeSha });
    expect(await h.admin.human_actions.findFirstOrThrow({ where: { project_id: project.id, type: "repository_merge" } })).toMatchObject({ status: "completed" });
    expect(await h.admin.approvals.findFirstOrThrow({ where: { organization_id: orgId, tool: "pull_request_merge", args_preview: { contains: change.id } } })).toMatchObject({ auto_approved: true, status: "consumed" });
    expect(await h.admin.audit_logs.findFirstOrThrow({ where: { organization_id: orgId, action: "builder.repository_merge.auto_approve", target_id: change.id } })).toMatchObject({ result: "success" });
  });
});
