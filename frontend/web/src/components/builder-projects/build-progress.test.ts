import { describe, expect, it } from "vitest";
import type { BuilderProjectDto } from "@agent-studio/contracts";
import { buildEtaLabel, buildProgressPercent, buildProgressPhases, primaryBuilderRelease } from "./build-progress";

function project(overrides: Partial<BuilderProjectDto> = {}): BuilderProjectDto {
  return {
    id: "project-1", agent_id: "agent-1", request: "文章を要約する", target: "production", status: "analyzing",
    created_by: "user-1", created_at: "2026-09-21T12:00:00.000Z", updated_at: "2026-09-21T12:00:10.000Z", completed_at: null,
    latest_plan: null, gaps: [], human_actions: [], discovery_sources: [], change_sets: [], validation_runs: [], releases: [],
    runs: [{ id: "run-1", attempt: 1, status: "running", correlation_id: "correlation-1", error_class: null, error: null, started_at: "2026-09-21T12:00:01.000Z", finished_at: null, created_at: "2026-09-21T12:00:00.000Z", steps: [
      { id: "step-1", kind: "analyze_requirements", status: "running", attempts: 1, error_class: null, error: null, started_at: "2026-09-21T12:00:01.000Z", finished_at: null },
      { id: "step-2", kind: "resolve_capabilities", status: "pending", attempts: 0, error_class: null, error: null, started_at: null, finished_at: null },
      { id: "step-3", kind: "prepare_human_actions", status: "pending", attempts: 0, error_class: null, error: null, started_at: null, finished_at: null },
    ] }],
    ...overrides,
  };
}

function release(status: BuilderProjectDto["releases"][number]["status"], id: string, createdAt: string): BuilderProjectDto["releases"][number] {
  return {
    id, status, agent_id: "agent-1", build_id: `build-${id}`, preview_deployment_id: `preview-${id}`, preview_run_id: `run-${id}`,
    production_deployment_id: status === "production_succeeded" ? `production-${id}` : null,
    production_run_id: status === "production_succeeded" ? `production-run-${id}` : null,
    rollback_target_deployment_id: null, config_hash: "hash", required_tools: [], created_at: createdAt, finished_at: createdAt,
  };
}

describe("Builder progress", () => {
  it("現在の工程と進捗率をBuilder Stepから算出する", () => {
    const phases = buildProgressPhases(project());
    expect(phases[0]).toMatchObject({ label: "依頼内容を解析", status: "running" });
    expect(phases.at(-1)).toMatchObject({ label: "本番で利用可能にする", status: "pending" });
    expect(buildProgressPercent(phases)).toBeGreaterThan(0);
  });

  it("通常時間を超えた処理は曖昧にせず長時間化を表示する", () => {
    expect(buildEtaLabel(project(), Date.parse("2026-09-21T12:05:00.000Z"))).toContain("通常より時間");
  });

  it("人の承認待ちは処理時間ではなく停止中として扱う", () => {
    const waiting = project({
      status: "production_pending_approval",
      human_actions: [{ id: "action-1", type: "production_approval", title: "本番承認", reason: "Preview成功", assignee_role: "admin", fields: [], instructions: [], resume_condition: {}, response: null, status: "pending", completed_at: null, expires_at: null, created_at: "2026-09-21T12:01:00.000Z" }],
    });
    expect(buildEtaLabel(waiting, Date.parse("2026-09-21T12:10:00.000Z"))).toBe("承認後 約1〜3分");
    expect(buildProgressPhases(waiting).at(-1)?.status).toBe("waiting");
  });

  it("完了後は新しい中止Previewより成功したProductionを進捗へ使う", () => {
    const completed = project({
      status: "completed",
      completed_at: "2026-09-21T12:10:00.000Z",
      releases: [
        release("preview_cancelled", "duplicate", "2026-09-21T12:11:00.000Z"),
        release("production_succeeded", "production", "2026-09-21T12:10:00.000Z"),
      ],
    });
    expect(primaryBuilderRelease(completed)?.id).toBe("production");
    expect(buildProgressPhases(completed).find((phase) => phase.key === "preview")?.status).toBe("completed");
    expect(buildProgressPhases(completed).find((phase) => phase.key === "production")?.status).toBe("completed");
    expect(buildProgressPhases(completed).some((phase) => phase.status === "failed")).toBe(false);
  });

  it("カスタム実装の確認待ちは確認後の所要時間を表示する", () => {
    const waiting = project({
      status: "waiting_human_action",
      latest_plan: {
        id: "plan-1", version: 1, requirements: [{ requirement: "社内DBを読む", state: "missing", connector_id: null, connector_name: null, tool_names: [], confidence: 1, reason: "専用Toolが必要", variables: [], fulfillment: { mode: "organization_tool", owner: "organization", execution_location: "runtime", reason: "社内データ", availability_target_minutes: null } }],
        graph: { nodes: [], edges: [] }, risks: [], execution_locations: [], created_at: "2026-09-21T12:01:00.000Z",
      },
      human_actions: [{ id: "action-1", type: "business_rule_confirmation", title: "Tool作成を確認", reason: "実装開始前の確認", assignee_role: "builder", fields: [], instructions: [], resume_condition: {}, response: null, status: "pending", completed_at: null, expires_at: null, created_at: "2026-09-21T12:01:00.000Z" }],
    });
    expect(buildEtaLabel(waiting, Date.parse("2026-09-21T12:10:00.000Z"))).toBe("確認後 約5〜15分");
  });

  it("企業専用ToolはPR反映とRuntime登録を別工程で表示する", () => {
    const reflecting = project({
      status: "waiting_human_action",
      change_sets: [{ id: "change-1", kind: "code_workspace", status: "pr_open", summary: "社内Tool", risk: "read", artifacts: [], source_hash: "hash", created_at: "2026-09-21T12:01:00.000Z" }],
      human_actions: [{ id: "action-1", type: "repository_merge", title: "PR反映", reason: "承認済み", assignee_role: "admin", fields: [], instructions: [], resume_condition: { type: "git_pr_merged" }, response: { merge_requested: "true" }, status: "pending", completed_at: null, expires_at: null, created_at: "2026-09-21T12:02:00.000Z" }],
    });
    const phases = buildProgressPhases(reflecting);
    expect(phases.find((phase) => phase.key === "repository")).toMatchObject({ status: "running", label: "Integration Repositoryへ反映" });
    expect(phases.find((phase) => phase.key === "tool_delivery")).toMatchObject({ status: "pending", label: "RuntimeへデプロイしてToolを登録" });
    expect(buildEtaLabel(reflecting, Date.parse("2026-09-21T12:03:00.000Z"))).toBe("反映中 約5〜15分");
  });

  it("PR承認待ちではAgent生成を完了とし、suiteごとの過去の失敗を現在状態へ混ぜない", () => {
    const waiting = project({
      status: "waiting_human_action",
      updated_at: "2026-09-21T12:05:10.000Z",
      change_sets: [{ id: "change-1", kind: "code_workspace", status: "pr_open", summary: "社内Tool", risk: "read", artifacts: [], source_hash: "hash", created_at: "2026-09-21T12:01:00.000Z" }],
      human_actions: [{ id: "action-1", type: "repository_merge", title: "PR #1の変更を反映", reason: "承認待ち", assignee_role: "admin", fields: [], instructions: [], resume_condition: { type: "git_pr_merged" }, response: null, status: "pending", completed_at: null, expires_at: null, created_at: "2026-09-21T12:05:10.000Z" }],
      validation_runs: [
        { id: "validation-git", suite: "git_provider" as never, environment: "builder", status: "passed", evidence: {}, error_class: null, error: null, created_at: "2026-09-21T12:05:06.000Z", finished_at: "2026-09-21T12:05:10.000Z" },
        { id: "validation-current", suite: "security", environment: "builder", status: "passed", evidence: {}, error_class: null, error: null, created_at: "2026-09-21T12:04:00.000Z", finished_at: "2026-09-21T12:04:05.000Z" },
        { id: "validation-old", suite: "security", environment: "builder", status: "failed", evidence: {}, error_class: "test", error: "修正前の失敗", created_at: "2026-09-21T12:02:00.000Z", finished_at: "2026-09-21T12:02:03.000Z" },
      ],
    });
    const phases = buildProgressPhases(waiting);
    expect(phases.find((phase) => phase.key === "implementation")).toMatchObject({ status: "completed", detail: "Agent定義と実行構成を固定しました" });
    expect(phases.find((phase) => phase.key === "validation")).toMatchObject({ status: "completed", detail: "必要な検証を通過しました" });
    expect(phases.find((phase) => phase.key === "repository")).toMatchObject({ status: "waiting", startedAt: "2026-09-21T12:05:06.000Z", finishedAt: "2026-09-21T12:05:10.000Z" });
  });
});
