import { createHash } from "node:crypto";
import { z } from "zod";
import { adapterDescriptorSchema, canonicalJson } from "@agent-studio/contracts";
import type { Prisma } from "@prisma/client";
import type { Deps } from "./deps.js";
import { parseGitHubAppMetadata, parseGitHubAppSecret, verifyGitHubWebhookSignature } from "../infrastructure/git/github-app.js";
import { AppError } from "../domain/errors.js";
import { verifyAdapterPackageSignature } from "../infrastructure/git/adapter-signature.js";
import { BuilderGitAutomationService } from "./builder-git-automation.js";

const deploymentEvidenceSchema = z.object({
  change_set_id: z.uuid(),
  runtime_id: z.uuid(),
  connector_key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  descriptor_hash: z.string().regex(/^[0-9a-f]{64}$/),
  contract_hash: z.string().regex(/^[0-9a-f]{64}$/),
  image_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  package_signature: z.string().min(20).max(1000),
  sbom_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  dependency_scan: z.object({ status: z.literal("passed"), critical: z.literal(0) }).strict(),
  secret_scan: z.object({ status: z.literal("passed"), findings: z.literal(0) }).strict(),
  provenance: z.object({ builder: z.string().min(1), source_repository: z.string().min(1), build_context: z.string().min(1) }).passthrough(),
  descriptor: adapterDescriptorSchema,
  /** CIがGitHub Releaseへ添付したAdapter package。あればRuntimeへ導入jobを送る */
  package: z.object({ release_asset_id: z.number().int().positive() }).strict().optional(),
}).strict();

type WebhookHeaders = { delivery: string | null; event: string | null; signature: string | null };

export class GitWebhookService {
  private readonly automation: BuilderGitAutomationService;

  constructor(private readonly deps: Deps) {
    this.automation = new BuilderGitAutomationService(deps);
  }

  async handle(headers: WebhookHeaders, rawBody: string): Promise<{ accepted: true; duplicate?: boolean }> {
    if (!headers.delivery || !headers.event) throw new AppError("invalid_webhook", 400, "GitHub webhook headersがありません");
    const payload = JSON.parse(rawBody) as Record<string, unknown>;
    const repository = payload.repository && typeof payload.repository === "object" ? payload.repository as Record<string, unknown> : {};
    const repositoryId = typeof repository.id === "number" || typeof repository.id === "string" ? String(repository.id) : null;
    if (!repositoryId) throw new AppError("invalid_webhook", 400, "GitHub repository IDがありません");
    const candidates = await this.deps.system.listGitHubConnections(repositoryId);
    if (candidates.length === 0) throw new AppError("repository_not_allowed", 403, "repository allowlist外です");
    const payloadHash = createHash("sha256").update(rawBody).digest("hex");
    for (const candidate of candidates) {
      const connection = await this.deps.db.org(candidate.organization_id, (tx) => tx.connections.findUnique({ where: { id: candidate.connection_id } }));
      if (!connection?.secret_locator) continue;
      const stored = await this.deps.secrets.get(connection.secret_locator);
      if (!stored) continue;
      const secret = parseGitHubAppSecret(stored);
      if (!verifyGitHubWebhookSignature(secret.webhook_secret, rawBody, headers.signature)) continue;
      const duplicate = await this.deps.db.org(candidate.organization_id, (tx) => tx.git_webhook_deliveries.findUnique({
        where: { organization_id_delivery_id: { organization_id: candidate.organization_id, delivery_id: headers.delivery! } },
      }));
      if (duplicate) return { accepted: true, duplicate: true };
      const metadata = parseGitHubAppMetadata(connection.metadata);
      if (metadata.repository_id !== repositoryId) throw new AppError("repository_not_allowed", 403, "repository allowlist外です");
      if (headers.event === "pull_request") {
        await this.handlePullRequest(candidate.organization_id, metadata, secret, payload);
        const rawPull = payload.pull_request && typeof payload.pull_request === "object" ? payload.pull_request as Record<string, unknown> : {};
        const rawHead = rawPull.head && typeof rawPull.head === "object" ? rawPull.head as Record<string, unknown> : {};
        if (["opened", "reopened", "synchronize"].includes(String(payload.action)) && typeof rawHead.sha === "string") {
          await this.automation.tryAutoMergeByHead(candidate.organization_id, metadata.repository_url, rawHead.sha, null);
        }
      }
      if ((headers.event === "check_suite" || headers.event === "check_run") && payload.action === "completed") {
        const rawCheck = payload[headers.event] && typeof payload[headers.event] === "object" ? payload[headers.event] as Record<string, unknown> : {};
        const nestedSuite = rawCheck.check_suite && typeof rawCheck.check_suite === "object" ? rawCheck.check_suite as Record<string, unknown> : {};
        const headSha = typeof rawCheck.head_sha === "string" ? rawCheck.head_sha : typeof nestedSuite.head_sha === "string" ? nestedSuite.head_sha : null;
        if (headSha) await this.automation.tryAutoMergeByHead(candidate.organization_id, metadata.repository_url, headSha, null);
      }
      if (headers.event === "deployment_status") await this.handleDeployment(candidate.organization_id, connection.id, metadata, payload);
      await this.deps.db.org(candidate.organization_id, (tx) => tx.git_webhook_deliveries.create({ data: {
        organization_id: candidate.organization_id,
        delivery_id: headers.delivery!,
        event: headers.event!,
        repository_id: repositoryId,
        payload_hash: payloadHash,
      } }));
      return { accepted: true };
    }
    throw new AppError("invalid_signature", 401, "GitHub webhook署名が一致しません");
  }

  private async handlePullRequest(organizationId: string, metadata: ReturnType<typeof parseGitHubAppMetadata>, secret: ReturnType<typeof parseGitHubAppSecret>, payload: Record<string, unknown>) {
    const action = payload.action;
    const raw = payload.pull_request && typeof payload.pull_request === "object" ? payload.pull_request as Record<string, unknown> : {};
    const number = typeof payload.number === "number" ? payload.number : null;
    const merged = raw.merged === true;
    if (action !== "closed" || !merged || !number) return;
    const changes = await this.deps.db.org(organizationId, (tx) => tx.builder_change_sets.findMany({ where: { pr_number: number, status: "pr_open" } }));
    const change = changes.find((candidate) => {
      const artifacts = Array.isArray(candidate.artifacts) ? candidate.artifacts as Array<Record<string, unknown>> : [];
      const repositoryUrl = artifacts.find((artifact) => artifact.type === "repository")?.id;
      return repositoryUrl === metadata.repository_url;
    });
    if (!change?.head_sha) return;
    const [pull, checks] = await Promise.all([
      this.deps.gitProvider.getPullRequest(metadata, secret, number),
      this.deps.gitProvider.getRequiredChecks(metadata, secret, change.head_sha),
    ]);
    if (!pull.merged || !pull.merge_commit_sha || pull.head.sha !== change.head_sha || !checks.complete || !checks.successful) {
      await this.deps.db.org(organizationId, async (tx) => {
        await tx.builder_change_sets.update({ where: { id: change.id }, data: { status: "failed" } });
        await tx.builder_validation_runs.create({ data: {
          organization_id: organizationId, project_id: change.project_id, suite: "git_merge", environment: "builder", status: "failed",
          evidence: { change_set_id: change.id, pr_number: number, expected_head_sha: change.head_sha, actual_head_sha: pull.head.sha, checks: checks.checks },
          error_class: "merge_verification", error: "merge commit、head SHA、Required Checksの検証に失敗しました", finished_at: new Date(),
        } });
      });
      return;
    }
    await this.deps.db.org(organizationId, async (tx) => {
      await tx.builder_change_sets.update({ where: { id: change.id }, data: { status: "merged", merge_sha: pull.merge_commit_sha } });
      await tx.builder_validation_runs.create({ data: {
        organization_id: organizationId, project_id: change.project_id, suite: "git_merge", environment: "builder", status: "passed",
        evidence: { change_set_id: change.id, pr_number: number, head_sha: pull.head.sha, base_sha: pull.base.sha, merge_sha: pull.merge_commit_sha, checks: checks.checks }, finished_at: new Date(),
      } });
      await tx.human_actions.updateMany({ where: { project_id: change.project_id, type: "repository_merge", status: "pending" }, data: { status: "completed", completed_at: new Date() } });
      const action = await tx.human_actions.findFirst({ where: { project_id: change.project_id, type: "adapter_delivery", status: "pending" } });
      if (!action) await tx.human_actions.create({ data: {
        organization_id: organizationId, project_id: change.project_id, type: "adapter_delivery", title: "署名付きAdapter packageのPreview配布を待っています",
        reason: "merge commitからのCI build、SBOM、scan、署名、digest固定を検証してからToolを登録するためです", assignee_role: "admin", fields: [],
        instructions: ["CIでmerge commitからpackageをbuildします", "GitHub Deploymentのpayloadへ署名・digest・scan証跡を含めます", "Runtime heartbeat一致で自動再開します"],
        resume_condition: { type: "adapter_registered", change_set_id: change.id, merge_sha: pull.merge_commit_sha },
      } });
      await tx.builder_projects.update({ where: { id: change.project_id }, data: { status: "waiting_human_action" } });
    });
  }

  private async handleDeployment(organizationId: string, connectionId: string, metadata: ReturnType<typeof parseGitHubAppMetadata>, payload: Record<string, unknown>) {
    const status = payload.deployment_status && typeof payload.deployment_status === "object" ? payload.deployment_status as Record<string, unknown> : {};
    const deployment = payload.deployment && typeof payload.deployment === "object" ? payload.deployment as Record<string, unknown> : {};
    if (status.state !== "success" || deployment.environment !== "preview") return;
    const rawPayload = deployment.payload && typeof deployment.payload === "object" ? deployment.payload as Record<string, unknown> : {};
    const evidence = deploymentEvidenceSchema.parse(rawPayload.agent_studio);
    const change = await this.deps.db.org(organizationId, (tx) => tx.builder_change_sets.findFirst({ where: { id: evidence.change_set_id, status: "merged" } }));
    if (!change?.merge_sha || deployment.ref !== change.merge_sha) throw new AppError("invalid_deployment", 409, "merge commitとAdapter deploymentが一致しません");
    const actualDescriptorHash = createHash("sha256").update(canonicalJson(evidence.descriptor)).digest("hex");
    const actualContractHash = createHash("sha256").update(canonicalJson(evidence.descriptor.tools)).digest("hex");
    if (actualDescriptorHash !== evidence.descriptor_hash || actualContractHash !== evidence.contract_hash || evidence.descriptor.source.merge_commit !== change.merge_sha || evidence.descriptor.connector.key !== evidence.connector_key) {
      throw new AppError("invalid_descriptor", 409, "Adapter descriptorのhash、merge commit、connector keyが一致しません");
    }
    if (evidence.provenance.source_repository.toLowerCase() !== `${metadata.owner}/${metadata.repository}`.toLowerCase()) {
      throw new AppError("repository_not_allowed", 403, "provenanceのrepositoryがallowlistと一致しません");
    }
    if (!verifyAdapterPackageSignature(metadata.package_signing_public_key, {
      source_commit: change.merge_sha,
      descriptor_hash: evidence.descriptor_hash,
      contract_hash: evidence.contract_hash,
      image_digest: evidence.image_digest,
      sbom_digest: evidence.sbom_digest,
    }, evidence.package_signature)) {
      throw new AppError("invalid_package_signature", 409, "Adapter packageのEd25519署名を検証できません");
    }
    await this.deps.db.org(organizationId, async (tx) => {
      const runtime = await tx.runtimes.findFirst({ where: { id: evidence.runtime_id, organization_id: organizationId, status: { in: ["active", "degraded"] } } });
      if (!runtime) throw new AppError("runtime_unavailable", 412, "Preview Runtimeが利用できません");
      await tx.builder_adapter_packages.upsert({
        where: { change_set_id: change.id },
        create: {
          organization_id: organizationId, project_id: change.project_id, change_set_id: change.id, runtime_id: evidence.runtime_id,
          status: "deployed", connector_key: evidence.connector_key, descriptor_hash: evidence.descriptor_hash, contract_hash: evidence.contract_hash,
          source_commit: change.merge_sha!, image_digest: evidence.image_digest, signature: evidence.package_signature,
          provenance: { ...evidence.provenance, descriptor: evidence.descriptor, sbom_digest: evidence.sbom_digest, dependency_scan: evidence.dependency_scan, secret_scan: evidence.secret_scan } as Prisma.InputJsonValue,
          health_status: "pending", deployed_at: new Date(),
        },
        update: {
          runtime_id: evidence.runtime_id, status: "deployed", connector_key: evidence.connector_key, descriptor_hash: evidence.descriptor_hash,
          contract_hash: evidence.contract_hash, source_commit: change.merge_sha!, image_digest: evidence.image_digest, signature: evidence.package_signature,
          provenance: { ...evidence.provenance, descriptor: evidence.descriptor, sbom_digest: evidence.sbom_digest, dependency_scan: evidence.dependency_scan, secret_scan: evidence.secret_scan } as Prisma.InputJsonValue,
          health_status: "pending", error_class: null, error: null, deployed_at: new Date(),
        },
      });
      if (evidence.package) {
        // 同じpackageの導入jobは1つだけ（webhookの再送・Re-runで重ねない）
        const existingJob = await tx.runtime_jobs.findFirst({
          where: {
            runtime_id: evidence.runtime_id,
            type: "install_adapter",
            status: { in: ["pending", "leased", "succeeded"] },
            AND: [
              { payload: { path: ["change_set_id"], equals: change.id } },
              { payload: { path: ["image_digest"], equals: evidence.image_digest } },
            ],
          },
        });
        if (!existingJob) await tx.runtime_jobs.create({ data: {
          organization_id: organizationId,
          runtime_id: evidence.runtime_id,
          type: "install_adapter",
          payload: {
            type: "install_adapter",
            project_id: change.project_id,
            change_set_id: change.id,
            connection_id: connectionId,
            repository_url: metadata.repository_url,
            release_asset_id: evidence.package.release_asset_id,
            connector_key: evidence.connector_key,
            source_commit: change.merge_sha!,
            descriptor_hash: evidence.descriptor_hash,
            contract_hash: evidence.contract_hash,
            image_digest: evidence.image_digest,
            sbom_digest: evidence.sbom_digest,
            package_signature: evidence.package_signature,
            signing_public_key: metadata.package_signing_public_key,
            descriptor: evidence.descriptor,
          } as Prisma.InputJsonValue,
        } });
      }
      await tx.builder_validation_runs.create({ data: {
        organization_id: organizationId, project_id: change.project_id, suite: "adapter_package", environment: "preview", status: "passed",
        evidence: { change_set_id: change.id, source_commit: change.merge_sha, connector_key: evidence.connector_key, descriptor_hash: evidence.descriptor_hash, contract_hash: evidence.contract_hash, image_digest: evidence.image_digest, sbom_digest: evidence.sbom_digest, critical_vulnerabilities: 0, secret_findings: 0, signature_present: true }, finished_at: new Date(),
      } });
    });
  }
}
