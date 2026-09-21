import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { BrowserLoginSessionDto, BrowserProfileDto, BrowserRelayTicketDto, CreateBrowserProfileInput } from "@agent-studio/contracts";
import { conflict, notFound, preconditionFailed, validationError } from "../domain/errors.js";
import { recordAudit } from "../infrastructure/audit.js";
import { auditBy, requireRole, scopeOf, type MemberActor } from "./context.js";
import type { Deps } from "./deps.js";

const LOGIN_TTL_MS = 15 * 60_000;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const profileDto = (row: {
  id: string; runtime_id: string; project_id: string | null; provider_key: string; display_name: string;
  environment: string; allowed_domains: unknown; status: string; last_verified_at: Date | null; expires_at: Date | null; created_at: Date;
}): BrowserProfileDto => ({
  id: row.id, runtime_id: row.runtime_id, project_id: row.project_id, provider_key: row.provider_key,
  display_name: row.display_name, environment: row.environment as BrowserProfileDto["environment"],
  allowed_domains: Array.isArray(row.allowed_domains) ? row.allowed_domains.filter((v): v is string => typeof v === "string") : [],
  status: row.status as BrowserProfileDto["status"], last_verified_at: row.last_verified_at?.toISOString() ?? null,
  expires_at: row.expires_at?.toISOString() ?? null, created_at: row.created_at.toISOString(),
});

const loginDto = (row: { id: string; profile_id: string; status: string; expires_at: Date; completed_at: Date | null; error: string | null }): BrowserLoginSessionDto => ({
  id: row.id, profile_id: row.profile_id, status: row.status as BrowserLoginSessionDto["status"],
  expires_at: row.expires_at.toISOString(), completed_at: row.completed_at?.toISOString() ?? null,
  error: row.error, launch_path: `/settings/browser-profiles/${row.profile_id}/login/${row.id}`,
});

export class BrowserProfileService {
  constructor(private readonly deps: Deps) {}

  async list(actor: MemberActor): Promise<BrowserProfileDto[]> {
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      await tx.browser_profiles.updateMany({
        where: { organization_id: actor.organizationId, status: "active", expires_at: { lte: new Date() } },
        data: { status: "expired" },
      });
      return (await tx.browser_profiles.findMany({ where: { organization_id: actor.organizationId }, orderBy: { created_at: "desc" } })).map(profileDto);
    });
  }

  async create(actor: MemberActor, input: CreateBrowserProfileInput): Promise<BrowserProfileDto> {
    requireRole(actor, "builder");
    const domains = [...new Set(input.allowed_domains.map((domain) => domain.toLowerCase().replace(/\.$/, "")))];
    if (domains.some((domain) => !DOMAIN.test(domain) || domain === "localhost" || isIP(domain) !== 0 || !domain.includes("."))) {
      throw validationError("接続先ドメインはIPやpublic suffixではなく、完全なドメイン名で指定してください");
    }
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      if (input.project_id) {
        const project = await tx.builder_projects.findFirst({ where: { id: input.project_id, organization_id: actor.organizationId } });
        if (!project) throw notFound("作成プロジェクト");
      }
      const runtime = input.runtime_id
        ? await tx.runtimes.findFirst({ where: { id: input.runtime_id, organization_id: actor.organizationId, stage: input.environment, status: "active" } })
        : await tx.runtimes.findFirst({
            where: { organization_id: actor.organizationId, stage: input.environment, status: "active", last_heartbeat_at: { gte: new Date(Date.now() - 120_000) } },
            orderBy: { last_heartbeat_at: "desc" },
          });
      if (!runtime) throw preconditionFailed(`${input.environment}の接続済みRuntimeが必要です`);
      const row = await tx.browser_profiles.create({ data: {
        organization_id: actor.organizationId, runtime_id: runtime.id, project_id: input.project_id,
        provider_key: input.provider_key, display_name: input.display_name, environment: input.environment,
        allowed_domains: domains, created_by: actor.userId,
      } });
      await recordAudit(tx, auditBy(actor, { action: "browser_profile.create", targetType: "browser_profile", targetId: row.id, detail: { runtime_id: runtime.id, provider_key: input.provider_key, environment: input.environment, allowed_domains: domains } }));
      return profileDto(row);
    });
  }

  async startLogin(actor: MemberActor, profileId: string): Promise<BrowserLoginSessionDto> {
    requireRole(actor, "builder");
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const profile = await tx.browser_profiles.findFirst({ where: { id: profileId, organization_id: actor.organizationId } });
      if (!profile) throw notFound("Browser Profile");
      if (profile.status === "revoked") throw conflict("無効化したBrowser Profileは再接続できません");
      const active = await tx.browser_login_sessions.findFirst({ where: { profile_id: profileId, status: { in: ["pending", "running"] }, expires_at: { gt: new Date() } } });
      if (active) return loginDto(active);
      await tx.browser_login_sessions.updateMany({ where: { profile_id: profileId, status: { in: ["pending", "running"] } }, data: { status: "expired" } });
      const action = profile.project_id ? await tx.human_actions.findFirst({
        where: { project_id: profile.project_id, type: "human_login", status: "pending" }, orderBy: { created_at: "desc" },
      }) : null;
      const expiresAt = new Date(Date.now() + LOGIN_TTL_MS);
      const session = await tx.browser_login_sessions.create({ data: {
        organization_id: actor.organizationId, profile_id: profile.id, runtime_id: profile.runtime_id,
        project_id: profile.project_id, human_action_id: action?.id, relay_token_hash: randomBytes(32).toString("hex"),
        expires_at: expiresAt, created_by: actor.userId,
      } });
      const job = await tx.runtime_jobs.create({ data: {
        organization_id: actor.organizationId, runtime_id: profile.runtime_id, type: "start_browser_login",
        payload: { type: "start_browser_login", login_session_id: session.id, profile_id: profile.id, provider_key: profile.provider_key, allowed_domains: profile.allowed_domains, expires_at: expiresAt.toISOString() },
      } });
      const updated = await tx.browser_login_sessions.update({ where: { id: session.id }, data: { runtime_job_id: job.id, status: "running" } });
      await recordAudit(tx, auditBy(actor, { action: "browser_profile.login.start", targetType: "browser_login_session", targetId: session.id, detail: { profile_id: profile.id, runtime_id: profile.runtime_id, expires_at: expiresAt.toISOString(), credential_body_persisted: false } }));
      return loginDto(updated);
    });
  }

  async getLogin(actor: MemberActor, sessionId: string): Promise<BrowserLoginSessionDto> {
    const row = await this.deps.db.run(scopeOf(actor), (tx) => tx.browser_login_sessions.findFirst({ where: { id: sessionId, organization_id: actor.organizationId } }));
    if (!row) throw notFound("Browser Login Session");
    return loginDto(row);
  }

  async issueRelayTicket(actor: MemberActor, sessionId: string): Promise<BrowserRelayTicketDto> {
    requireRole(actor, "builder");
    const token = randomBytes(32).toString("base64url");
    const row = await this.deps.db.run(scopeOf(actor), async (tx) => {
      const login = await tx.browser_login_sessions.findFirst({ where: { id: sessionId, organization_id: actor.organizationId } });
      if (!login) throw notFound("Browser Login Session");
      if (!['pending', 'running'].includes(login.status) || login.expires_at <= new Date()) {
        throw conflict("このBrowser Login Sessionは終了しています");
      }
      const updated = await tx.browser_login_sessions.update({
        where: { id: login.id },
        data: { relay_token_hash: createHash("sha256").update(token).digest("hex") },
      });
      await recordAudit(tx, auditBy(actor, {
        action: "browser_profile.login.relay_ticket",
        targetType: "browser_login_session",
        targetId: login.id,
        detail: { expires_at: login.expires_at.toISOString(), token_persisted: false },
      }));
      return updated;
    });
    const base = new URL(this.deps.env.PUBLIC_API_BASE_URL);
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    base.pathname = "/relay/v1/browser-login";
    base.search = "";
    base.hash = "";
    return { session_id: row.id, token, websocket_url: base.toString(), expires_at: row.expires_at.toISOString() };
  }

  async cancelLogin(actor: MemberActor, sessionId: string): Promise<void> {
    requireRole(actor, "builder");
    await this.deps.db.run(scopeOf(actor), async (tx) => {
      const row = await tx.browser_login_sessions.findFirst({ where: { id: sessionId, organization_id: actor.organizationId } });
      if (!row) throw notFound("Browser Login Session");
      if (!["pending", "running"].includes(row.status)) throw conflict("このLogin Sessionは終了しています");
      await tx.browser_login_sessions.update({ where: { id: sessionId }, data: { status: "cancelled", completed_at: new Date() } });
      if (row.runtime_job_id) await tx.runtime_jobs.updateMany({ where: { id: row.runtime_job_id, status: "pending" }, data: { status: "cancelled", completed_at: new Date() } });
      await recordAudit(tx, auditBy(actor, { action: "browser_profile.login.cancel", targetType: "browser_login_session", targetId: sessionId, detail: {} }));
    });
  }

  async revoke(actor: MemberActor, profileId: string): Promise<void> {
    requireRole(actor, "admin");
    await this.deps.db.run(scopeOf(actor), async (tx) => {
      const row = await tx.browser_profiles.findFirst({ where: { id: profileId, organization_id: actor.organizationId } });
      if (!row) throw notFound("Browser Profile");
      await tx.browser_profiles.update({ where: { id: profileId }, data: { status: "revoked", revoked_at: new Date() } });
      await tx.browser_login_sessions.updateMany({ where: { profile_id: profileId, status: { in: ["pending", "running"] } }, data: { status: "cancelled", completed_at: new Date() } });
      if (row.runtime_object_key) {
        await tx.runtime_jobs.create({ data: {
          organization_id: actor.organizationId,
          runtime_id: row.runtime_id,
          type: "revoke_browser_profile",
          payload: { type: "revoke_browser_profile", profile_id: row.id, runtime_object_key: row.runtime_object_key },
        } });
      }
      await recordAudit(tx, auditBy(actor, { action: "browser_profile.revoke", targetType: "browser_profile", targetId: profileId, detail: { runtime_id: row.runtime_id, deletion_queued: Boolean(row.runtime_object_key) } }));
    });
  }
}
