import type { Prisma, PrismaClient, users } from "@prisma/client";

export type Tx = Prisma.TransactionClient;

export interface TenantScope {
  /** 操作中の組織（RLS の app.organization_id） */
  organizationId: string | null;
  /** 操作している利用者（RLS の app.user_id） */
  userId: string | null;
}

/**
 * RLS の文脈を設定したトランザクションで処理する（SEC-04）。
 * set_config の第3引数 true でトランザクション内だけ有効にするため、接続プールで他のリクエストに漏れない。
 * トランザクション内で外部 API（OpenAI など）を呼ばないこと。
 */
export class TenantDb {
  constructor(private readonly prisma: PrismaClient) {}

  run<T>(scope: TenantScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.organization_id', ${scope.organizationId ?? ""}, true), set_config('app.user_id', ${scope.userId ?? ""}, true)`;
        return fn(tx);
      },
      { maxWait: 5000, timeout: 20000 },
    );
  }

  /** 組織の文脈で処理する（利用者なし: Worker や Runtime からの操作） */
  org<T>(organizationId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.run({ organizationId, userId: null }, fn);
  }
}

/**
 * 組織をまたぐ必要がある処理。migrations の SECURITY DEFINER 関数だけを呼ぶ。
 * 返すのは ID など最小限の情報にとどめ、中身は TenantDb で組織の文脈を設定して読む。
 */
export class SystemDb {
  constructor(private readonly prisma: PrismaClient) {}

  async resolveUser(subject: string, email: string, displayName: string | null): Promise<users> {
    const rows = await this.prisma.$queryRaw<users[]>`SELECT * FROM auth_resolve_user(${subject}, ${email}, ${displayName})`;
    const user = rows[0];
    if (!user) throw new Error("ユーザーを解決できませんでした");
    return user;
  }

  async inviteResolveUser(tx: Tx, email: string): Promise<string> {
    const rows = await tx.$queryRaw<{ invite_resolve_user: string }[]>`SELECT invite_resolve_user(${email})`;
    return rows[0]!.invite_resolve_user;
  }

  async resolveRuntimePrincipal(
    accountId: string,
    roleName: string,
  ): Promise<{ runtime_id: string; organization_id: string; status: string; stage: string } | null> {
    const rows = await this.prisma.$queryRaw<
      { runtime_id: string; organization_id: string; status: string; stage: string }[]
    >`SELECT * FROM runtime_resolve_principal(${accountId}, ${roleName})`;
    return rows[0] ?? null;
  }

  async consumeBootstrapToken(
    tokenHash: string,
    accountId: string,
    roleName: string,
  ): Promise<{ runtime_id: string; organization_id: string; stage: string } | null> {
    const rows = await this.prisma.$queryRaw<
      { runtime_id: string; organization_id: string; stage: string }[]
    >`SELECT * FROM runtime_consume_bootstrap_token(${tokenHash}, ${accountId}, ${roleName})`;
    return rows[0] ?? null;
  }

  async consumeBrowserLoginTicket(sessionId: string, tokenHash: string): Promise<{ organization_id: string; runtime_id: string; expires_at: Date } | null> {
    const rows = await this.prisma.$queryRaw<Array<{ organization_id: string; runtime_id: string; expires_at: Date }>>`
      SELECT * FROM system_consume_browser_login_ticket(${sessionId}::uuid, ${tokenHash})`;
    return rows[0] ?? null;
  }

  claimRuns(owner: string, leaseSeconds: number, limit: number) {
    return this.prisma.$queryRaw<{ run_id: string; organization_id: string }[]>`
      SELECT * FROM system_claim_runs(${owner}, ${leaseSeconds}::integer, ${limit}::integer)`;
  }

  claimBuilderRuns(owner: string, leaseSeconds: number, limit: number) {
    return this.prisma.$queryRaw<{ builder_run_id: string; organization_id: string }[]>`
      SELECT * FROM system_claim_builder_runs(${owner}, ${leaseSeconds}::integer, ${limit}::integer)`;
  }

  claimBuilderWorkspaceSessions(owner: string, leaseSeconds: number, limit: number) {
    return this.prisma.$queryRaw<{ builder_session_id: string; organization_id: string }[]>`
      SELECT * FROM system_claim_builder_workspace_sessions(${owner}, ${leaseSeconds}::integer, ${limit}::integer)`;
  }

  async resolveDeploymentApiKey(keyHash: string) {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; organization_id: string; deployment_id: string; rate_limit_per_minute: number; max_runs_per_day: number }>>`
      SELECT * FROM system_resolve_deployment_api_key(${keyHash})`;
    return rows[0] ?? null;
  }

  async resolveDeploymentWebhook(id: string) {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; organization_id: string; deployment_id: string; secret_locator: string; rate_limit_per_minute: number; max_runs_per_day: number }>>`
      SELECT * FROM system_resolve_deployment_webhook(${id}::uuid)`;
    return rows[0] ?? null;
  }

  listActiveBuilderPreviews(owner: string, limit: number) {
    return this.prisma.$queryRaw<{ builder_release_id: string; organization_id: string }[]>`
      SELECT * FROM system_list_active_builder_previews(${owner}, ${limit}::integer)`;
  }

  listActiveBuilderProductionRuns(owner: string, limit: number) {
    return this.prisma.$queryRaw<{ builder_release_id: string; organization_id: string }[]>`
      SELECT * FROM system_list_active_builder_production_runs(${owner}, ${limit}::integer)`;
  }

  listBuilderReleasesForDrift(owner: string, limit: number) {
    return this.prisma.$queryRaw<{ builder_release_id: string; organization_id: string }[]>`
      SELECT * FROM system_list_builder_releases_for_drift(${owner}, ${limit}::integer)`;
  }

  expireApprovals() {
    return this.prisma.$queryRaw<
      { approval_id: string; organization_id: string; run_id: string | null; workflow_run_id: string | null }[]
    >`SELECT * FROM system_expire_approvals()`;
  }

  async markStaleRuntimes(offlineAfterSeconds: number): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ n: number }[]>`
      SELECT system_mark_stale_runtimes(${offlineAfterSeconds}::integer) AS n`;
    return Number(rows[0]?.n ?? 0);
  }

  async requeueExpiredJobs(maxAttempts: number): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ n: number }[]>`
      SELECT system_requeue_expired_jobs(${maxAttempts}::integer) AS n`;
    return Number(rows[0]?.n ?? 0);
  }

  async expireConnections(): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ n: number }[]>`SELECT system_expire_connections() AS n`;
    return Number(rows[0]?.n ?? 0);
  }

  claimConnectionHealthChecks(owner: string, staleSeconds: number, limit: number) {
    return this.prisma.$queryRaw<Array<{ connection_id: string; organization_id: string }>>`
      SELECT * FROM system_claim_connection_health_checks(${owner}, ${staleSeconds}::integer, ${limit}::integer)`;
  }

  async heartbeatWorker(workerId: string, activeRuns: number, activeSessions: number): Promise<void> {
    await this.prisma.worker_heartbeats.upsert({
      where: { worker_id: workerId },
      create: { worker_id: workerId, active_runs: activeRuns, active_sessions: activeSessions },
      update: { active_runs: activeRuns, active_sessions: activeSessions, last_seen_at: new Date() },
    });
  }

  async readinessSnapshot() {
    const [worker, staleRuntimes, unhealthyDeployments, failedRuntimeJobs] = await Promise.all([
      this.prisma.worker_heartbeats.findFirst({ orderBy: { last_seen_at: "desc" } }),
      this.prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) AS count FROM runtimes WHERE status NOT IN ('revoked', 'pending') AND (last_heartbeat_at IS NULL OR last_heartbeat_at < now() - interval '3 minutes')`,
      this.prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) AS count FROM deployments WHERE stage = 'production' AND status = 'active' AND health_status <> 'ready'`,
      this.prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) AS count FROM runtime_jobs WHERE status = 'failed' AND updated_at >= now() - interval '15 minutes'`,
    ]);
    const workerAgeMs = worker ? Date.now() - worker.last_seen_at.getTime() : null;
    return {
      worker: { healthy: workerAgeMs !== null && workerAgeMs <= 45_000, last_seen_at: worker?.last_seen_at.toISOString() ?? null, active_runs: worker?.active_runs ?? 0, active_sessions: worker?.active_sessions ?? 0 },
      stale_runtimes: Number(staleRuntimes[0]?.count ?? 0),
      unhealthy_production_deployments: Number(unhealthyDeployments[0]?.count ?? 0),
      recent_failed_runtime_jobs: Number(failedRuntimeJobs[0]?.count ?? 0),
    };
  }

  listActiveWorkflowRuns(owner: string, limit: number) {
    return this.prisma.$queryRaw<{ workflow_run_id: string; organization_id: string }[]>`
      SELECT * FROM system_list_active_workflow_runs(${owner}, ${limit}::integer)`;
  }

  listSessionsToCleanup(owner: string, limit: number) {
    return this.prisma.$queryRaw<{ session_id: string; organization_id: string }[]>`
      SELECT * FROM system_list_sessions_to_cleanup(${owner}, ${limit}::integer)`;
  }

  listExternalJobs(owner: string, limit: number) {
    return this.prisma.$queryRaw<{ job_id: string; organization_id: string }[]>`
      SELECT * FROM system_list_external_jobs(${owner}, ${limit}::integer)`;
  }

  listGitHubConnections(repositoryId: string) {
    return this.prisma.$queryRaw<{ connection_id: string; organization_id: string }[]>`
      SELECT * FROM system_list_github_connections(${repositoryId})`;
  }

  claimDueSchedules(owner: string, leaseSeconds: number, limit: number) {
    return this.prisma.$queryRaw<{ schedule_id: string; organization_id: string }[]>`
      SELECT * FROM system_claim_due_schedules(${owner}, ${leaseSeconds}::integer, ${limit}::integer)`;
  }

  listRunningEvalRuns(owner: string, limit: number) {
    return this.prisma.$queryRaw<{ eval_run_id: string; organization_id: string }[]>`
      SELECT * FROM system_list_running_eval_runs(${owner}, ${limit}::integer)`;
  }

  exportAuditLogs(from: Date, to: Date) {
    return this.prisma.$queryRaw<Record<string, unknown>[]>`SELECT * FROM system_export_audit_logs(${from}, ${to})`;
  }
}
