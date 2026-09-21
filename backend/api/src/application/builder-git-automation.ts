import { canonicalJson, toolCallHash } from "@agent-studio/contracts";
import { evaluateOrganizationAutoApproval } from "../domain/organization-auto-approval.js";
import { isOrganizationIntegrationRepository } from "../domain/git-repository-policy.js";
import { parseGitHubAppMetadata, parseGitHubAppSecret } from "../infrastructure/git/github-app.js";
import { recordAudit } from "../infrastructure/audit.js";
import type { Deps } from "./deps.js";

export type AutoMergeResult = "merged" | "waiting_checks" | "manual_required" | "not_applicable";

/** Required Checks成功後のmergeだけを、version固定の組織Policyで自動承認する。 */
export class BuilderGitAutomationService {
  constructor(private readonly deps: Deps) {}

  async tryAutoMerge(organizationId: string, changeSetId: string, sourceIp: string | null = null): Promise<AutoMergeResult> {
    const candidate = await this.deps.db.org(organizationId, async (tx) => {
      const change = await tx.builder_change_sets.findFirst({ where: { id: changeSetId, organization_id: organizationId, status: "pr_open" } });
      if (!change?.head_sha || !change.pr_number) return null;
      const artifacts = Array.isArray(change.artifacts) ? change.artifacts as Array<Record<string, unknown>> : [];
      const repositoryUrl = artifacts.find((artifact) => artifact.type === "repository")?.id;
      if (typeof repositoryUrl !== "string") return null;
      const connection = await tx.connections.findFirst({
        where: { organization_id: organizationId, status: "connected", revoked_at: null, metadata: { path: ["repository_url"], equals: repositoryUrl } },
      });
      if (!connection?.secret_locator) return null;
      const metadata = parseGitHubAppMetadata(connection.metadata);
      if (!isOrganizationIntegrationRepository(metadata as unknown as Record<string, unknown>)) return null;
      const auto = await evaluateOrganizationAutoApproval(tx, organizationId, {
        actionKind: "pull_request_merge",
        stage: "staging",
        operation: "pull_request_merge",
        risk: "write",
        requestedRecords: 1,
        now: new Date(),
      });
      return { change, metadata, secretLocator: connection.secret_locator, auto };
    });
    if (!candidate) return "not_applicable";
    if (!candidate.auto.policy || candidate.auto.decision.action !== "auto_approve") return "manual_required";

    const stored = await this.deps.secrets.get(candidate.secretLocator);
    if (!stored) return "manual_required";
    const secret = parseGitHubAppSecret(stored);
    const [pull, checks] = await Promise.all([
      this.deps.gitProvider.getPullRequest(candidate.metadata, secret, candidate.change.pr_number!),
      this.deps.gitProvider.getRequiredChecks(candidate.metadata, secret, candidate.change.head_sha!),
    ]);
    if (pull.merged || pull.state !== "open" || pull.head.sha !== candidate.change.head_sha || pull.base.ref !== candidate.metadata.base_branch) {
      return "not_applicable";
    }
    const builderValidation = checks.checks.length === 0
      ? await this.deps.db.org(organizationId, (tx) => tx.builder_validation_runs.findFirst({
          where: {
            project_id: candidate.change.project_id,
            suite: "builder_session",
            environment: "builder",
            status: "passed",
            evidence: { path: ["commit_sha"], equals: candidate.change.head_sha! },
          },
          orderBy: { created_at: "desc" },
        }))
      : null;
    const acceptedChecks = checks.checks.length > 0 ? checks.complete && checks.successful : Boolean(builderValidation);
    if (!acceptedChecks) return "waiting_checks";

    const now = new Date();
    const approval = await this.deps.db.org(organizationId, async (tx) => {
      const current = await tx.builder_change_sets.findFirst({ where: { id: candidate.change.id, status: "pr_open", head_sha: candidate.change.head_sha } });
      if (!current) return null;
      return tx.approvals.create({ data: {
        organization_id: organizationId,
        source: "builder",
        tool: "pull_request_merge",
        args_hash: await toolCallHash("pull_request_merge", { change_set_id: current.id, pr_number: current.pr_number, head_sha: current.head_sha }),
        args_preview: canonicalJson({ change_set_id: current.id, pr_number: current.pr_number, head_sha: current.head_sha, base_branch: candidate.metadata.base_branch }).slice(0, 4000),
        reason: "Required Checks成功済みの専用branchを既定branchへmerge",
        status: "approved",
        expires_at: new Date(now.getTime() + 15 * 60_000),
        decided_at: now,
        auto_approved: true,
        auto_approval_policy_id: candidate.auto.policy!.id,
        auto_approval_policy_version: candidate.auto.policy!.version,
        auto_approval_reason: candidate.auto.decision.reason,
      } });
    });
    if (!approval) return "not_applicable";

    try {
      const merged = await this.deps.gitProvider.mergePullRequest(candidate.metadata, secret, pull.number, candidate.change.head_sha!);
      if (!merged.merged || !merged.sha) throw new Error(merged.message || "GitHubでPRをmergeできませんでした");
      const verifiedChecks = checks.checks.length > 0 ? checks.checks : ["agent-studio-builder-session:completed:success"];
      await this.deps.db.org(organizationId, async (tx) => {
        const updated = await tx.builder_change_sets.updateMany({
          where: { id: candidate.change.id, status: "pr_open", head_sha: candidate.change.head_sha },
          data: { status: "merged", merge_sha: merged.sha },
        });
        if (updated.count === 0) return;
        await tx.builder_validation_runs.create({ data: {
          organization_id: organizationId,
          project_id: candidate.change.project_id,
          suite: "git_merge",
          environment: "builder",
          status: "passed",
          evidence: { change_set_id: candidate.change.id, pr_number: pull.number, head_sha: candidate.change.head_sha, base_sha: pull.base.sha, merge_sha: merged.sha, checks: verifiedChecks, auto_approved: true },
          finished_at: new Date(),
        } });
        await tx.human_actions.updateMany({
          where: { project_id: candidate.change.project_id, type: "repository_merge", status: "pending" },
          data: { status: "completed", response: { merge_requested: "true", merge_sha: merged.sha, approved_by: "organization_policy" }, completed_at: new Date() },
        });
        const deliveryAction = await tx.human_actions.findFirst({ where: { project_id: candidate.change.project_id, type: "adapter_delivery", status: "pending" } });
        if (!deliveryAction) await tx.human_actions.create({ data: {
          organization_id: organizationId,
          project_id: candidate.change.project_id,
          type: "adapter_delivery",
          title: "署名付きAdapter packageのPreview配布を待っています",
          reason: "merge commitからのCI build、SBOM、scan、署名、digest固定を検証してからToolを登録するためです",
          assignee_role: "admin",
          fields: [],
          instructions: ["CIでmerge commitからpackageをbuildします", "GitHub Deploymentのpayloadへ署名・digest・scan証跡を含めます", "Runtime heartbeat一致で自動再開します"],
          resume_condition: { type: "adapter_registered", change_set_id: candidate.change.id, merge_sha: merged.sha },
        } });
        await tx.builder_projects.update({ where: { id: candidate.change.project_id }, data: { status: "waiting_human_action" } });
        await tx.approvals.update({ where: { id: approval.id }, data: { status: "consumed", consumed_at: new Date() } });
        await recordAudit(tx, {
          organizationId,
          actorType: "system",
          actorId: candidate.auto.policy!.id,
          actorLabel: "Organization Policy",
          sourceIp,
          action: "builder.repository_merge.auto_approve",
          targetType: "builder_change_set",
          targetId: candidate.change.id,
          detail: { project_id: candidate.change.project_id, pr_number: pull.number, head_sha: candidate.change.head_sha, merge_sha: merged.sha, checks: verifiedChecks, approval_id: approval.id, policy_version: candidate.auto.policy!.version },
        });
      });
      return "merged";
    } catch (error) {
      await this.deps.db.org(organizationId, async (tx) => {
        await tx.approvals.updateMany({ where: { id: approval.id, status: "approved" }, data: { status: "expired", comment: "PR自動mergeに失敗したため管理者確認へ戻しました" } });
        await recordAudit(tx, {
          organizationId,
          actorType: "system",
          actorId: candidate.auto.policy!.id,
          actorLabel: "Organization Policy",
          sourceIp,
          action: "builder.repository_merge.auto_approve",
          targetType: "builder_change_set",
          targetId: candidate.change.id,
          result: "failure",
          detail: { pr_number: pull.number, approval_id: approval.id, error: error instanceof Error ? error.message.slice(0, 500) : "merge_failed" },
        });
      });
      return "manual_required";
    }
  }

  async tryAutoMergeByHead(organizationId: string, repositoryUrl: string, headSha: string, sourceIp: string | null = null): Promise<void> {
    const changes = await this.deps.db.org(organizationId, (tx) => tx.builder_change_sets.findMany({ where: { status: "pr_open", head_sha: headSha } }));
    for (const change of changes) {
      const artifacts = Array.isArray(change.artifacts) ? change.artifacts as Array<Record<string, unknown>> : [];
      if (artifacts.find((artifact) => artifact.type === "repository")?.id !== repositoryUrl) continue;
      await this.tryAutoMerge(organizationId, change.id, sourceIp);
    }
  }
}
