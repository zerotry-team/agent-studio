import type { BrowserSessionConfig, SessionGrant } from "@agent-studio/contracts";

export type WorkerStatus = "starting" | "running" | "stopping";

export interface WorkerInfo {
  status: WorkerStatus;
  /** ECS のタスク ARN（docker のときはコンテナ ID） */
  taskArn?: string;
  startedAt: Date;
  /** Controller が停止を指示した理由（停止後の報告を worker_stopped にするため） */
  stopReason?: string;
}

export interface SessionRecord {
  grant: SessionGrant;
  openaiSessionId?: string;
  environmentId?: string;
  /** Controller の上限で丸めた最大寿命（分） */
  maxLifetimeMinutes: number;
  idleTimeoutMinutes?: number;
  /** Session Worker をこの Controller が管理しているとき */
  worker?: WorkerInfo;
  /** Run 専用 Browser Session Worker。accessToken は監査・ログへ出さない。 */
  browser?: WorkerInfo & { accessToken: string; config: BrowserSessionConfig };
  /** Builder Session のとき、作業領域を受け渡してよい Change Set */
  builderChangeSetId?: string;
}

/**
 * セッションの許可情報（SessionGrant）と Session Worker の管理状態。メモリだけに持つ。
 * Controller が再起動したら Agent Studio の activeSessions から作り直す。
 */
export class GrantStore {
  private readonly bySession = new Map<string, SessionRecord>();
  private readonly byTokenHash = new Map<string, string>();
  /** Runtime が失効している間は Tool Gateway にセッションを見せない */
  suspended = false;

  get(sessionId: string): SessionRecord | undefined {
    return this.bySession.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.bySession.has(sessionId);
  }

  /** 追加、または許可情報だけを更新する（Worker の状態は変えない） */
  upsert(grant: SessionGrant, extra: Partial<Omit<SessionRecord, "grant">> = {}, defaultLifetimeMinutes = 120): SessionRecord {
    const existing = this.bySession.get(grant.session_id);
    if (existing) {
      if (existing.grant.token_hash !== grant.token_hash) this.byTokenHash.delete(existing.grant.token_hash);
      // browser.endpoint はRuntime内で解決するためControl PlaneのactiveSessionsには含まれない。
      // 許可情報の再同期でRun専用endpointを消さない。
      existing.grant = existing.grant.browser && !grant.browser ? { ...grant, browser: existing.grant.browser } : grant;
      Object.assign(existing, extra);
      this.byTokenHash.set(grant.token_hash, grant.session_id);
      return existing;
    }
    const record: SessionRecord = { maxLifetimeMinutes: defaultLifetimeMinutes, ...extra, grant };
    this.bySession.set(grant.session_id, record);
    this.byTokenHash.set(grant.token_hash, grant.session_id);
    return record;
  }

  remove(sessionId: string): SessionRecord | undefined {
    const record = this.bySession.get(sessionId);
    if (!record) return undefined;
    this.bySession.delete(sessionId);
    if (this.byTokenHash.get(record.grant.token_hash) === sessionId) this.byTokenHash.delete(record.grant.token_hash);
    return record;
  }

  /** Tool Gateway 向け: 有効期限内の許可情報だけを返す */
  lookupByTokenHash(tokenHash: string, now: Date = new Date()): SessionGrant | undefined {
    if (this.suspended) return undefined;
    const sessionId = this.byTokenHash.get(tokenHash.toLowerCase());
    if (!sessionId) return undefined;
    const record = this.bySession.get(sessionId);
    if (!record) return undefined;
    if (Date.parse(record.grant.expires_at) <= now.getTime()) return undefined;
    return record.grant;
  }

  /** Worker を管理しているセッション（起動中・実行中・停止中） */
  workerSessions(): SessionRecord[] {
    return [...this.bySession.values()].filter((r) => r.worker !== undefined);
  }

  activeWorkerCount(): number {
    return this.workerSessions().length;
  }

  activeSessionIds(): string[] {
    return this.workerSessions().map((r) => r.grant.session_id);
  }

  /**
   * Agent Studio の activeSessions と突き合わせる。
   * 許可情報を更新し、Worker を持たないセッションのうち一覧に無いものは消す。
   */
  syncFromActive(grants: SessionGrant[], defaultLifetimeMinutes: number): void {
    const active = new Set(grants.map((g) => g.session_id));
    for (const g of grants) this.upsert(g, {}, defaultLifetimeMinutes);
    for (const record of [...this.bySession.values()]) {
      if (!record.worker && !active.has(record.grant.session_id)) this.remove(record.grant.session_id);
    }
  }

  /** Worker を持たず、期限の切れた許可情報を消す */
  sweepExpired(now: Date = new Date()): number {
    let removed = 0;
    for (const record of [...this.bySession.values()]) {
      if (!record.worker && Date.parse(record.grant.expires_at) <= now.getTime()) {
        this.remove(record.grant.session_id);
        removed++;
      }
    }
    return removed;
  }

  size(): number {
    return this.bySession.size;
  }
}
