import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Deps } from "../application/deps.js";
import { hashToken } from "../application/environments.js";
import type { ManagedRuntimeInfrastructureOutput } from "../infrastructure/aws/managed-runtime-provisioner.js";

const BOOTSTRAP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const NEXT_ACCOUNT_POLL_MS = 15_000;
const NEXT_CONNECTION_POLL_MS = 20_000;

/**
 * One resumable step of Studio-managed Runtime provisioning.
 * External AWS/Terraform calls intentionally run outside database transactions.
 */
export class ManagedRuntimeProvisioningDriver {
  constructor(
    private readonly deps: Deps,
    private readonly runtimeId: string,
    private readonly organizationId: string,
  ) {}

  async drive(): Promise<void> {
    try {
      const runtime = await this.deps.db.org(this.organizationId, (tx) =>
        tx.runtimes.findFirst({ where: { id: this.runtimeId, organization_id: this.organizationId } }),
      );
      if (!runtime || runtime.status === "revoked" || !runtime.provisioning_status) return;

      switch (runtime.provisioning_status) {
        case "queued":
        case "account_creating":
          await this.ensureAccount(runtime);
          return;
        case "infrastructure_applying":
          await this.applyInfrastructure(runtime);
          return;
        case "bootstrap_configuring":
          await this.configureBootstrap(runtime);
          return;
        case "connecting":
          await this.waitForConnection(runtime.status);
          return;
        case "completed":
        case "failed":
          return;
        default:
          throw new Error(`不明な構築状態です: ${runtime.provisioning_status}`);
      }
    } catch (error) {
      await this.fail(error);
    }
  }

  private async ensureAccount(runtime: {
    provisioning_account_name: string | null;
    provisioning_account_email: string | null;
    provisioning_request_id: string | null;
  }): Promise<void> {
    if (!runtime.provisioning_account_name || !runtime.provisioning_account_email) {
      throw new Error("AWSアカウント作成情報がありません");
    }
    const result = await this.deps.managedRuntimeProvisioner.ensureAccount({
      accountName: runtime.provisioning_account_name,
      accountEmail: runtime.provisioning_account_email,
      requestId: runtime.provisioning_request_id,
    });
    if (result.status === "failed") throw new Error(`AWSアカウントの作成に失敗しました: ${result.message}`);
    if (result.status === "pending") {
      await this.update({
        provisioning_status: "account_creating",
        provisioning_step: "専用AWSアカウントを作成しています",
        provisioning_progress: 20,
        provisioning_request_id: result.requestId,
        provisioning_lease_until: new Date(Date.now() + NEXT_ACCOUNT_POLL_MS),
      });
      return;
    }
    await this.update({
      aws_account_id: result.accountId,
      provisioning_request_id: result.requestId,
      provisioning_status: "infrastructure_applying",
      provisioning_step: "AWS基盤の構築を待っています",
      provisioning_progress: 40,
      provisioning_lease_owner: null,
      provisioning_lease_until: null,
    });
  }

  private async applyInfrastructure(runtime: {
    aws_account_id: string | null;
    aws_region: string;
    stage: string;
    expected_role_name: string;
    provisioning_tenant_short: string | null;
  }): Promise<void> {
    if (!runtime.aws_account_id || !runtime.provisioning_tenant_short) throw new Error("AWS基盤の構築情報がありません");
    if (runtime.stage !== "staging" && runtime.stage !== "production") throw new Error(`対応していない環境です: ${runtime.stage}`);
    await this.update({ provisioning_step: "VPC・ECS・IAMを構築しています", provisioning_progress: 55 });
    const output = await this.deps.managedRuntimeProvisioner.applyInfrastructure({
      organizationId: this.organizationId,
      runtimeId: this.runtimeId,
      accountId: runtime.aws_account_id,
      tenantShort: runtime.provisioning_tenant_short,
      stage: runtime.stage,
      region: runtime.aws_region,
    });
    if (output.runtimeRoleName !== runtime.expected_role_name) {
      throw new Error(`Runtime IAMロールが契約と一致しません: ${output.runtimeRoleName}`);
    }
    await this.update({
      provisioning_status: "bootstrap_configuring",
      provisioning_step: "Runtimeの初回接続を設定しています",
      provisioning_progress: 80,
      provisioning_outputs: output as unknown as Prisma.InputJsonValue,
      provisioning_lease_owner: null,
      provisioning_lease_until: null,
    });
  }

  private async configureBootstrap(runtime: {
    aws_account_id: string | null;
    aws_region: string;
    stage: string;
    provisioning_tenant_short: string | null;
    provisioning_outputs: Prisma.JsonValue;
  }): Promise<void> {
    if (!runtime.aws_account_id || !runtime.provisioning_tenant_short) throw new Error("Runtime接続情報がありません");
    if (runtime.stage !== "staging" && runtime.stage !== "production") throw new Error(`対応していない環境です: ${runtime.stage}`);
    const output = parseInfrastructureOutput(runtime.provisioning_outputs);
    const token = `asbt_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + BOOTSTRAP_TOKEN_TTL_MS);
    await this.deps.db.org(this.organizationId, (tx) => tx.runtime_bootstrap_tokens.create({
      data: {
        organization_id: this.organizationId,
        runtime_id: this.runtimeId,
        token_hash: hashToken(token),
        expires_at: expiresAt,
        created_by: null,
      },
    }));
    await this.deps.managedRuntimeProvisioner.configureBootstrap({
      organizationId: this.organizationId,
      runtimeId: this.runtimeId,
      accountId: runtime.aws_account_id,
      tenantShort: runtime.provisioning_tenant_short,
      stage: runtime.stage,
      region: runtime.aws_region,
      ...output,
    }, token);
    await this.update({
      provisioning_status: "connecting",
      provisioning_step: "Runtimeの接続を待っています",
      provisioning_progress: 90,
      provisioning_lease_owner: null,
      provisioning_lease_until: new Date(Date.now() + NEXT_CONNECTION_POLL_MS),
    });
  }

  private async waitForConnection(runtimeStatus: string): Promise<void> {
    if (runtimeStatus !== "active") {
      await this.update({
        provisioning_step: "Runtimeの接続を待っています",
        provisioning_lease_until: new Date(Date.now() + NEXT_CONNECTION_POLL_MS),
      });
      return;
    }
    await this.deps.db.org(this.organizationId, async (tx) => {
      await tx.runtimes.update({
        where: { id: this.runtimeId },
        data: {
          provisioning_status: "completed",
          provisioning_step: "Runtimeの準備が完了しました",
          provisioning_progress: 100,
          provisioning_error: null,
          provisioning_lease_owner: null,
          provisioning_lease_until: null,
          provisioning_completed_at: new Date(),
        },
      });
      await tx.audit_logs.create({
        data: {
          organization_id: this.organizationId,
          actor_type: "system",
          action: "runtime.managed_provisioning.complete",
          target_type: "runtime",
          target_id: this.runtimeId,
          result: "success",
          detail: {},
        },
      });
    });
  }

  private update(data: Prisma.runtimesUpdateInput): Promise<unknown> {
    return this.deps.db.org(this.organizationId, (tx) => tx.runtimes.update({ where: { id: this.runtimeId }, data }));
  }

  private async fail(error: unknown): Promise<void> {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
    this.deps.logger.error({ err: error, runtime_id: this.runtimeId }, "Managed Runtimeの自動構築に失敗しました");
    await this.deps.db.org(this.organizationId, async (tx) => {
      const runtime = await tx.runtimes.findUnique({ where: { id: this.runtimeId } });
      if (!runtime || runtime.status === "revoked") return;
      await tx.runtimes.update({
        where: { id: this.runtimeId },
        data: {
          provisioning_status: "failed",
          provisioning_step: "構築に失敗しました",
          provisioning_error: message,
          provisioning_lease_owner: null,
          provisioning_lease_until: null,
        },
      });
      await tx.audit_logs.create({
        data: {
          organization_id: this.organizationId,
          actor_type: "system",
          action: "runtime.managed_provisioning.fail",
          target_type: "runtime",
          target_id: this.runtimeId,
          result: "failure",
          detail: { error: message },
        },
      });
    });
  }
}

function parseInfrastructureOutput(value: Prisma.JsonValue): ManagedRuntimeInfrastructureOutput {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Terraform出力がありません");
  const output = value as Record<string, unknown>;
  const required = ["bootstrapSecretId", "clusterName", "runtimeCoreServiceName", "runtimeRoleName"] as const;
  for (const key of required) if (typeof output[key] !== "string" || !output[key]) throw new Error(`Terraform出力 ${key} がありません`);
  return output as unknown as ManagedRuntimeInfrastructureOutput;
}
