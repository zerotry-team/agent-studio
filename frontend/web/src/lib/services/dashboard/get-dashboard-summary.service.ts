import "server-only";
import type { ApprovalDto, RunDto, RuntimeDto, RuntimeProfileDto } from "@agent-studio/contracts";
import { SessionExpiredError } from "@/lib/auth/session";
import { ApprovalRepository, RunRepository, RuntimeProfileRepository, RuntimeRepository } from "@/lib/repositories";

export interface DashboardSummary {
  /** 取得できなかった項目は null */
  recentRuns: RunDto[] | null;
  pendingApprovals: ApprovalDto[] | null;
  runtimes: RuntimeDto[] | null;
  profiles: RuntimeProfileDto[] | null;
  /** 一部の取得に失敗したときのメッセージ */
  warnings: string[];
}

/** ダッシュボード用の要約。一部が失敗しても、取得できたものは表示する */
export class GetDashboardSummaryService {
  constructor(
    private readonly runs = new RunRepository(),
    private readonly approvals = new ApprovalRepository(),
    private readonly runtimes = new RuntimeRepository(),
    private readonly profiles = new RuntimeProfileRepository(),
  ) {}

  async invoke(): Promise<DashboardSummary> {
    const results = await Promise.allSettled([
      this.runs.list({ limit: 8 }),
      this.approvals.list({ status: "pending" }),
      this.runtimes.list(),
      this.profiles.list(),
    ]);

    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    const sessionError = rejected.find((r) => r.reason instanceof SessionExpiredError);
    if (sessionError) throw sessionError.reason;
    if (rejected.length === results.length) throw rejected[0]!.reason;

    const value = <T,>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);
    const warnings = Array.from(
      new Set(rejected.map((r) => (r.reason instanceof Error ? r.reason.message : "一部の情報を取得できませんでした"))),
    );

    return {
      recentRuns: value(results[0]),
      pendingApprovals: value(results[1]),
      runtimes: value(results[2]),
      profiles: value(results[3]),
      warnings,
    };
  }
}
