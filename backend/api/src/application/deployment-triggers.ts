import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { CreateDeploymentCredentialInput, CreatedDeploymentApiKeyDto, CreatedDeploymentWebhookDto, DeploymentApiKeyDto, DeploymentWebhookDto } from "@agent-studio/contracts";
import { AppError, conflict, notFound, preconditionFailed, unauthorized } from "../domain/errors.js";
import { secretNames } from "../infrastructure/secrets/secret-store.js";
import { auditBy, requireRole, scopeOf, type MemberActor } from "./context.js";
import { recordAudit } from "../infrastructure/audit.js";
import { createRunInTx } from "./runs.js";
import type { Deps } from "./deps.js";

const iso = (value: Date | null) => value?.toISOString() ?? null;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

type LimitCredential = { id: string; organization_id: string; deployment_id: string; rate_limit_per_minute: number; max_runs_per_day: number };

export class DeploymentTriggerService {
  constructor(private readonly deps: Deps) {}

  async createApiKey(actor: MemberActor, deploymentId: string, input: CreateDeploymentCredentialInput): Promise<CreatedDeploymentApiKeyDto> {
    requireRole(actor, "admin");
    const secret = `as_live_${randomBytes(8).toString("hex")}_${randomBytes(32).toString("base64url")}`;
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      await this.assertProductionDeployment(tx, actor.organizationId, deploymentId);
      const row = await tx.deployment_api_keys.create({ data: {
        organization_id: actor.organizationId, deployment_id: deploymentId, name: input.name,
        key_prefix: secret.slice(0, 24), key_hash: hash(secret), rate_limit_per_minute: input.rate_limit_per_minute,
        max_runs_per_day: input.max_runs_per_day, expires_at: input.expires_at ? new Date(input.expires_at) : null, created_by: actor.userId,
      } });
      await recordAudit(tx, auditBy(actor, { action: "deployment.api_key.create", targetType: "deployment_api_key", targetId: row.id, detail: { deployment_id: deploymentId, key_prefix: row.key_prefix, rate_limit_per_minute: row.rate_limit_per_minute, max_runs_per_day: row.max_runs_per_day } }));
      return { ...this.apiKeyDto(row), secret };
    });
  }

  async listApiKeys(actor: MemberActor, deploymentId: string): Promise<DeploymentApiKeyDto[]> {
    requireRole(actor, "admin");
    return this.deps.db.run(scopeOf(actor), async (tx) => (await tx.deployment_api_keys.findMany({ where: { organization_id: actor.organizationId, deployment_id: deploymentId }, orderBy: { created_at: "desc" } })).map((row) => this.apiKeyDto(row)));
  }

  async revokeApiKey(actor: MemberActor, id: string): Promise<void> {
    requireRole(actor, "admin");
    await this.deps.db.run(scopeOf(actor), async (tx) => {
      const row = await tx.deployment_api_keys.findFirst({ where: { id, organization_id: actor.organizationId } });
      if (!row) throw notFound("Deployment API Key");
      await tx.deployment_api_keys.update({ where: { id }, data: { status: "revoked", revoked_at: new Date() } });
      await recordAudit(tx, auditBy(actor, { action: "deployment.api_key.revoke", targetType: "deployment_api_key", targetId: id, detail: { deployment_id: row.deployment_id } }));
    });
  }

  async createWebhook(actor: MemberActor, deploymentId: string, input: CreateDeploymentCredentialInput): Promise<CreatedDeploymentWebhookDto> {
    requireRole(actor, "admin");
    const id = randomUUID();
    const secret = `whsec_${randomBytes(32).toString("base64url")}`;
    const locator = await this.deps.secrets.put(secretNames.deploymentWebhook(this.deps.env.SECRETS_PREFIX, actor.organizationId, id), secret, { organization_id: actor.organizationId, deployment_id: deploymentId });
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      await this.assertProductionDeployment(tx, actor.organizationId, deploymentId);
      const row = await tx.deployment_webhooks.create({ data: { id, organization_id: actor.organizationId, deployment_id: deploymentId, name: input.name, secret_locator: locator, rate_limit_per_minute: input.rate_limit_per_minute, max_runs_per_day: input.max_runs_per_day, created_by: actor.userId } });
      await recordAudit(tx, auditBy(actor, { action: "deployment.webhook.create", targetType: "deployment_webhook", targetId: row.id, detail: { deployment_id: deploymentId, rate_limit_per_minute: row.rate_limit_per_minute, max_runs_per_day: row.max_runs_per_day } }));
      return { ...this.webhookDto(row), signing_secret: secret, path: `/webhooks/deployments/${row.id}` };
    });
  }

  async listWebhooks(actor: MemberActor, deploymentId: string): Promise<DeploymentWebhookDto[]> {
    requireRole(actor, "admin");
    return this.deps.db.run(scopeOf(actor), async (tx) => (await tx.deployment_webhooks.findMany({ where: { organization_id: actor.organizationId, deployment_id: deploymentId }, orderBy: { created_at: "desc" } })).map((row) => this.webhookDto(row)));
  }

  async revokeWebhook(actor: MemberActor, id: string): Promise<void> {
    requireRole(actor, "admin");
    await this.deps.db.run(scopeOf(actor), async (tx) => {
      const row = await tx.deployment_webhooks.findFirst({ where: { id, organization_id: actor.organizationId } });
      if (!row) throw notFound("Deployment Webhook");
      await tx.deployment_webhooks.update({ where: { id }, data: { status: "revoked", revoked_at: new Date() } });
      await recordAudit(tx, auditBy(actor, { action: "deployment.webhook.revoke", targetType: "deployment_webhook", targetId: id, detail: { deployment_id: row.deployment_id } }));
    });
  }

  async triggerWithApiKey(token: string | null, deploymentId: string, input: string): Promise<{ run_id: string }> {
    if (!token?.startsWith("as_live_")) throw unauthorized("Deployment API Keyが必要です");
    const credential = await this.deps.system.resolveDeploymentApiKey(hash(token));
    if (!credential || credential.deployment_id !== deploymentId) throw unauthorized("Deployment API Keyが無効です");
    return this.createTriggeredRun(credential, "api_key", null, input);
  }

  async triggerWithWebhook(webhookId: string, rawBody: string, signature: string | null, deliveryId: string | null): Promise<{ run_id: string; duplicate: boolean }> {
    if (!signature || !deliveryId || deliveryId.length > 200) throw unauthorized("Webhook署名またはdelivery IDがありません");
    const credential = await this.deps.system.resolveDeploymentWebhook(webhookId);
    if (!credential) throw notFound("Deployment Webhook");
    const secret = await this.deps.secrets.get(credential.secret_locator);
    if (!secret) throw unauthorized("Webhook署名を検証できません");
    const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    if (!safeEqual(expected, signature)) throw unauthorized("Webhook署名が一致しません");
    const parsed = JSON.parse(rawBody) as { input?: unknown };
    if (typeof parsed.input !== "string" || !parsed.input.trim() || parsed.input.length > 100_000) throw preconditionFailed("Webhook inputが正しくありません");
    const existing = await this.deps.db.org(credential.organization_id, (tx) => tx.deployment_trigger_invocations.findUnique({ where: { credential_type_credential_id_delivery_id: { credential_type: "webhook", credential_id: credential.id, delivery_id: deliveryId } } }));
    if (existing?.run_id) return { run_id: existing.run_id, duplicate: true };
    try {
      const result = await this.createTriggeredRun(credential, "webhook", deliveryId, parsed.input);
      return { ...result, duplicate: false };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "P2002") {
        const duplicate = await this.deps.db.org(credential.organization_id, (tx) => tx.deployment_trigger_invocations.findUnique({ where: { credential_type_credential_id_delivery_id: { credential_type: "webhook", credential_id: credential.id, delivery_id: deliveryId } } }));
        if (duplicate?.run_id) return { run_id: duplicate.run_id, duplicate: true };
      }
      throw error;
    }
  }

  private async createTriggeredRun(credential: LimitCredential, credentialType: "api_key" | "webhook", deliveryId: string | null, input: string): Promise<{ run_id: string }> {
    return this.deps.db.org(credential.organization_id, async (tx) => {
      const deployment = await tx.deployments.findFirst({ where: { id: credential.deployment_id, organization_id: credential.organization_id, stage: "production", status: "active", health_status: "ready" } });
      if (!deployment) throw conflict("Production Deploymentがhealthyではありません");
      const minute = new Date(Date.now() - 60_000);
      const day = new Date(Date.now() - 24 * 60 * 60_000);
      // interactive transactionは同じpg clientを使うため、queryを並列発行しない。
      const perMinute = await tx.deployment_trigger_invocations.count({ where: { credential_type: credentialType, credential_id: credential.id, created_at: { gte: minute }, status: "accepted" } });
      const perDay = await tx.deployment_trigger_invocations.count({ where: { credential_type: credentialType, credential_id: credential.id, created_at: { gte: day }, status: "accepted" } });
      if (perMinute >= credential.rate_limit_per_minute) throw new AppError("rate_limit_exceeded", 429, "1分あたりの実行上限を超えました");
      if (perDay >= credential.max_runs_per_day) throw new AppError("usage_cap_exceeded", 429, "24時間あたりのusage capを超えました");
      const run = await createRunInTx(tx, credential.organization_id, credential.deployment_id, input.trim(), null);
      await tx.deployment_trigger_invocations.create({ data: { organization_id: credential.organization_id, deployment_id: credential.deployment_id, credential_type: credentialType, credential_id: credential.id, delivery_id: deliveryId, request_hash: hash(input.trim()), status: "accepted", run_id: run.id } });
      if (credentialType === "api_key") await tx.deployment_api_keys.update({ where: { id: credential.id }, data: { last_used_at: new Date() } });
      else await tx.deployment_webhooks.update({ where: { id: credential.id }, data: { last_used_at: new Date() } });
      await tx.audit_logs.createMany({ data: [{ organization_id: credential.organization_id, actor_type: "api_key", actor_id: credential.id, action: `deployment.trigger.${credentialType}`, target_type: "run", target_id: run.id, result: "success", detail: { deployment_id: credential.deployment_id, request_hash: hash(input.trim()), delivery_id: deliveryId } }] });
      return { run_id: run.id };
    });
  }

  private async assertProductionDeployment(tx: Prisma.TransactionClient, organizationId: string, deploymentId: string) {
    const deployment = await tx.deployments.findFirst({ where: { id: deploymentId, organization_id: organizationId } });
    if (!deployment) throw notFound("Deployment");
    if (deployment.stage !== "production") throw conflict("Production Deploymentだけに外部Triggerを作成できます");
  }

  private apiKeyDto(row: { id: string; deployment_id: string; name: string; key_prefix: string; status: string; rate_limit_per_minute: number; max_runs_per_day: number; last_used_at: Date | null; expires_at: Date | null; created_at: Date }): DeploymentApiKeyDto {
    return { id: row.id, deployment_id: row.deployment_id, name: row.name, key_prefix: row.key_prefix, status: row.status as "active" | "revoked", rate_limit_per_minute: row.rate_limit_per_minute, max_runs_per_day: row.max_runs_per_day, last_used_at: iso(row.last_used_at), expires_at: iso(row.expires_at), created_at: row.created_at.toISOString() };
  }

  private webhookDto(row: { id: string; deployment_id: string; name: string; status: string; rate_limit_per_minute: number; max_runs_per_day: number; last_used_at: Date | null; created_at: Date }): DeploymentWebhookDto {
    return { id: row.id, deployment_id: row.deployment_id, name: row.name, status: row.status as "active" | "revoked", rate_limit_per_minute: row.rate_limit_per_minute, max_runs_per_day: row.max_runs_per_day, last_used_at: iso(row.last_used_at), created_at: row.created_at.toISOString() };
  }
}
