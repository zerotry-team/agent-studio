import type { BuilderProjectDto, BuilderStepDto } from "@agent-studio/contracts";

export type BuildPhaseStatus = "pending" | "running" | "completed" | "failed" | "waiting";

export interface BuildPhase {
  key: string;
  label: string;
  detail: string;
  status: BuildPhaseStatus;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface BuildLogEntry {
  key: string;
  at: string;
  status: "info" | "running" | "success" | "failed" | "waiting";
  message: string;
}

const STEP_LABELS: Record<string, string> = {
  analyze_requirements: "依頼内容を解析",
  resolve_capabilities: "モデル・Tool・Connectionを選定",
  prepare_human_actions: "必要な準備と安全境界を確認",
};

/** 完了後は、後から中止された重複Previewより実際に成功したProductionを表示する。 */
export function primaryBuilderRelease(project: BuilderProjectDto) {
  if (project.status === "completed") {
    return project.releases.find((release) => release.status === "production_succeeded")
      ?? project.releases.find((release) => release.status === "preview_succeeded")
      ?? project.releases.find((release) => release.status !== "preview_cancelled")
      ?? project.releases[0];
  }
  return project.releases[0];
}

function actionTitle(action: BuilderProjectDto["human_actions"][number]): string {
  const condition = action.resume_condition && typeof action.resume_condition === "object" && !Array.isArray(action.resume_condition)
    ? action.resume_condition as { type?: unknown; repository_connection_id?: unknown }
    : {};
  if (action.type === "provider_app_registration" && condition.type === "github_repository_connected") {
    return typeof condition.repository_connection_id === "string"
      ? "企業専用Integration Repositoryを自動準備します"
      : "GitHubと連携してください（初回のみ）";
  }
  return action.title;
}

function stepPhase(step: BuilderStepDto | undefined, label: string, runningDetail: string, completedDetail: string): BuildPhase {
  const status: BuildPhaseStatus = step?.status === "skipped" ? "completed" : step?.status ?? "pending";
  return {
    key: step?.kind ?? label,
    label,
    detail: step?.status === "completed" ? completedDetail : step?.status === "failed" ? step.error ?? "この工程で停止しました" : runningDetail,
    status,
    startedAt: step?.started_at ?? null,
    finishedAt: step?.finished_at ?? null,
  };
}

function releasePhase(project: BuilderProjectDto): BuildPhase {
  const release = primaryBuilderRelease(project);
  const status = release?.status;
  const failed = status === "preview_failed" || status === "preview_cancelled";
  const completed = Boolean(status && !["preview_running"].includes(status));
  return {
    key: "preview",
    label: "Previewで実行確認",
    detail: failed ? "Preview Runが成功しませんでした" : completed ? "実際のRunが成功しました" : status === "preview_running" ? "生成したAgentを実際に実行しています" : "Agent生成後に自動で実行します",
    status: failed ? "failed" : completed ? "completed" : status === "preview_running" ? "running" : "pending",
    startedAt: release?.created_at ?? null,
    finishedAt: completed || failed ? release?.finished_at ?? project.updated_at : null,
  };
}

export function buildProgressPhases(project: BuilderProjectDto): BuildPhase[] {
  const run = project.runs[0];
  const byKind = new Map(run?.steps.map((step) => [step.kind, step]) ?? []);
  const pendingHuman = project.human_actions.find((action) => action.status === "pending"
    && action.type !== "production_approval"
    && action.type !== "adapter_delivery"
    && action.type !== "repository_merge");
  const release = primaryBuilderRelease(project);
  const hasGeneratedAgent = Boolean(release || project.change_sets.some((change) => ["applied", "pr_open", "merged"].includes(change.status)));
  const generationValidation = project.validation_runs.find((validation) => String(validation.suite) === "builder_session" && validation.status === "passed");
  const implementationFailed = project.status === "failed" && !run?.steps.some((step) => step.status === "failed") && !release;
  const implementationRunning = ["implementing", "validating"].includes(project.status) && !release;
  const implementationWaiting = Boolean(pendingHuman);
  const implementation: BuildPhase = {
    key: "implementation",
    label: "Agentを生成",
    detail: implementationFailed
      ? run?.error ?? "Agent生成中に停止しました"
      : implementationWaiting
        ? `「${pendingHuman ? actionTitle(pendingHuman) : "必要な確認"}」を待っています（この間は自動処理が進みません）`
        : hasGeneratedAgent
          ? "Agent定義と実行構成を固定しました"
          : implementationRunning
            ? "Agent定義、必要な連携、実行構成を生成しています"
            : "必要な能力が確定すると自動で生成します",
    status: implementationFailed ? "failed" : implementationWaiting ? "waiting" : hasGeneratedAgent ? "completed" : implementationRunning ? "running" : "pending",
    startedAt: implementationRunning ? run?.finished_at ?? project.updated_at : hasGeneratedAgent ? generationValidation?.created_at ?? null : null,
    finishedAt: hasGeneratedAgent ? generationValidation?.finished_at ?? release?.created_at ?? project.updated_at : null,
  };

  const validations = project.validation_runs.filter((validation) => validation.suite !== "preview" && validation.suite !== "drift");
  // APIは新しい順。再試行前の失敗を現在の状態へ混ぜず、suiteごとの最新結果だけで判定する。
  const latestBySuite = new Map<string, BuilderProjectDto["validation_runs"][number]>();
  for (const validation of validations) if (!latestBySuite.has(validation.suite)) latestBySuite.set(validation.suite, validation);
  const currentValidations = [...latestBySuite.values()];
  const latestValidation = currentValidations[0];
  const validationFailed = currentValidations.some((validation) => validation.status === "failed" || validation.status === "blocked");
  const validationRunning = currentValidations.some((validation) => validation.status === "running") || project.status === "validating";
  const validationPassed = (currentValidations.length > 0 && currentValidations.every((validation) => validation.status === "passed")) || Boolean(release);
  const validation: BuildPhase = {
    key: "validation",
    label: "安全性と構成を検証",
    detail: validationFailed ? "検証で問題が見つかりました" : validationPassed ? "必要な検証を通過しました" : validationRunning ? "権限、接続、生成内容を検証しています" : "Agent生成後に自動で検証します",
    status: validationFailed ? "failed" : validationPassed ? "completed" : validationRunning ? "running" : "pending",
    startedAt: latestValidation?.created_at ?? null,
    finishedAt: validationPassed ? latestValidation?.finished_at ?? null : null,
  };

  const phases: BuildPhase[] = [
    stepPhase(byKind.get("analyze_requirements"), "依頼内容を解析", "目的と完了条件を整理しています", "目的と完了条件を整理しました"),
    stepPhase(byKind.get("resolve_capabilities"), "実行方法を決定", "モデル、Web Search、既存Toolを照合しています", "利用するモデルとToolを決定しました"),
    stepPhase(byKind.get("prepare_human_actions"), "必要な準備を確認", "接続・承認・不足機能の有無を確認しています", "自動で進められる範囲を確定しました"),
    implementation,
    validation,
  ];

  const codeChange = project.change_sets.find((change) => change.kind === "code_workspace");
  if (codeChange) {
    const mergeAction = project.human_actions.find((action) => action.type === "repository_merge");
    const mergeRequested = mergeAction?.status === "pending" && mergeAction.response?.merge_requested === "true";
    const repositoryFailed = codeChange.status === "failed";
    const repositoryMerged = codeChange.status === "merged";
    const repositoryValidation = project.validation_runs.find((validation) => String(validation.suite) === "git_provider" && validation.status === "passed");
    phases.push({
      key: "repository",
      label: "Integration Repositoryへ反映",
      detail: repositoryFailed
        ? "PRの作成または反映に失敗しました"
        : repositoryMerged
          ? "確認済みPRを既定branchへ反映しました"
          : mergeRequested
            ? "PRをmergeしています。GitHubの完了通知を待っています"
            : codeChange.status === "pr_open"
              ? "Required Checks済みPRの反映承認を待っています"
              : codeChange.status === "applied"
                ? "専用branchをpushし、PRを作成しています"
                : "Toolコードの生成後に専用branchとPRを作成します",
      status: repositoryFailed ? "failed" : repositoryMerged ? "completed" : codeChange.status === "pr_open" && !mergeRequested ? "waiting" : codeChange.status === "applied" || mergeRequested ? "running" : "pending",
      startedAt: repositoryValidation?.created_at ?? codeChange.created_at,
      // PR作成済みの承認待ちは処理時間へ含めない。待機開始時点で計測を止める。
      finishedAt: repositoryMerged ? project.updated_at : codeChange.status === "pr_open" ? repositoryValidation?.finished_at ?? project.updated_at : null,
    });

    const deliveryAction = project.human_actions.find((action) => action.type === "adapter_delivery");
    const deliveryCompleted = deliveryAction?.status === "completed";
    const deliveryRunning = deliveryAction?.status === "pending" || repositoryMerged;
    phases.push({
      key: "tool_delivery",
      label: "RuntimeへデプロイしてToolを登録",
      detail: deliveryCompleted
        ? "デプロイとRuntimeのTool登録を確認しました"
        : deliveryRunning
          ? "署名、scan、Runtime heartbeatを検証してToolを登録しています"
          : "PR反映後に自動でデプロイします",
      status: deliveryCompleted ? "completed" : deliveryRunning ? "running" : "pending",
      startedAt: deliveryAction?.created_at ?? (repositoryMerged ? project.updated_at : null),
      finishedAt: deliveryCompleted ? deliveryAction.completed_at ?? project.updated_at : null,
    });
  }

  phases.push(releasePhase(project));

  if (project.target === "production") {
    const productionFailed = release?.status === "production_failed" || release?.status === "rolled_back";
    const productionCompleted = release?.status === "production_succeeded";
    const productionRunning = release?.status === "production_running";
    const approval = project.human_actions.find((action) => action.type === "production_approval" && action.status === "pending");
    phases.push({
      key: "production",
      label: "本番で利用可能にする",
      detail: productionFailed ? "本番確認に失敗し、安全な状態へ戻しました" : productionCompleted ? "Productionの最終Runまで成功しました" : productionRunning ? "同じBuildを本番で最終確認しています" : approval ? "Preview済みの内容を本番へ反映する承認待ちです" : "Preview成功後に承認を依頼します",
      status: productionFailed ? "failed" : productionCompleted ? "completed" : productionRunning ? "running" : approval ? "waiting" : "pending",
      startedAt: release?.created_at ?? null,
      finishedAt: productionCompleted || productionFailed ? release?.finished_at ?? project.updated_at : null,
    });
  }
  return phases;
}

export function buildProgressPercent(phases: BuildPhase[]): number {
  if (!phases.length) return 0;
  const points = phases.reduce((total, phase) => total + (phase.status === "completed" ? 1 : phase.status === "running" ? 0.5 : 0), 0);
  return Math.min(100, Math.round((points / phases.length) * 100));
}

export function buildEtaLabel(project: BuilderProjectDto, nowMs: number): string {
  if (project.status === "completed") return "完了";
  if (project.status === "failed" || project.status === "blocked" || project.status === "cancelled") return "停止中";
  const customImplementation = project.latest_plan?.requirements.some((requirement) =>
    requirement.fulfillment?.mode === "organization_tool" || requirement.fulfillment?.mode === "shared_tool",
  ) || project.change_sets.some((change) => change.kind === "code_workspace");
  const pending = project.human_actions.find((action) => action.status === "pending");
  if (pending?.type === "production_approval") return "承認後 約1〜3分";
  if (pending?.type === "provider_app_registration") {
    const condition = pending.resume_condition && typeof pending.resume_condition === "object" && !Array.isArray(pending.resume_condition)
      ? pending.resume_condition as { repository_connection_id?: unknown }
      : {};
    return typeof condition.repository_connection_id === "string" ? "自動準備後 約5〜15分" : "GitHub連携後 約5〜15分";
  }
  if (pending?.type === "adapter_delivery" || (pending?.type === "repository_merge" && pending.response?.merge_requested === "true")) return "反映中 約5〜15分";
  const pendingCondition = pending?.resume_condition && typeof pending.resume_condition === "object" && !Array.isArray(pending.resume_condition)
    ? pending.resume_condition as { topic?: string; repository_url?: string }
    : {};
  if (pendingCondition.topic?.startsWith("code_workspace:") && pendingCondition.repository_url && /github\.com\/[^/]+\/agent-studio(?:\.git)?$/i.test(pendingCondition.repository_url)) return "接続後 約5〜15分";
  if (pending) return customImplementation ? "確認後 約5〜15分" : "確認後 約1〜3分";
  const elapsedMinutes = Math.max(0, (nowMs - Date.parse(project.created_at)) / 60_000);
  const range = ["previewing", "validating"].includes(project.status)
    ? { min: 1, max: 3, prefix: "あと" }
    : project.status === "implementing" && customImplementation
      ? { min: 5, max: 15, prefix: "あと" }
      : project.status === "implementing"
        ? { min: 1, max: 3, prefix: "あと" }
        : customImplementation
          ? { min: 5, max: 15, prefix: "全体" }
          : { min: 1, max: 3, prefix: "全体" };
  if (elapsedMinutes > range.max) return `通常より時間がかかっています（通常${range.min}〜${range.max}分）`;
  return `${range.prefix} 約${range.min}〜${range.max}分`;
}

export function buildLogEntries(project: BuilderProjectDto): BuildLogEntry[] {
  const entries: BuildLogEntry[] = [{ key: "project", at: project.created_at, status: "info", message: "作成リクエストを受け付けました" }];
  for (const run of [...project.runs].reverse()) {
    entries.push({ key: `run-${run.id}`, at: run.started_at ?? run.created_at, status: run.status === "failed" ? "failed" : run.status === "running" ? "running" : "info", message: `試行 ${run.attempt} を${run.started_at ? "開始" : "待機"}しました` });
    for (const step of run.steps) {
      if (!step.started_at && step.status === "pending") continue;
      entries.push({
        key: `step-${step.id}`,
        at: step.finished_at ?? step.started_at ?? run.created_at,
        status: step.status === "completed" ? "success" : step.status === "failed" ? "failed" : step.status === "running" ? "running" : "info",
        message: `${STEP_LABELS[step.kind] ?? step.kind}${step.status === "completed" ? "が完了しました" : step.status === "failed" ? `で停止しました${step.error ? `: ${step.error}` : ""}` : "を実行しています"}`,
      });
    }
  }
  for (const change of project.change_sets) entries.push({ key: `change-${change.id}`, at: change.created_at, status: change.status === "applied" ? "success" : "info", message: change.summary });
  for (const validation of project.validation_runs) entries.push({
    key: `validation-${validation.id}`,
    at: validation.finished_at ?? validation.created_at,
    status: validation.status === "passed" ? "success" : validation.status === "failed" || validation.status === "blocked" ? "failed" : "running",
    message: `${validation.suite} 検証: ${validation.status}${validation.error ? ` — ${validation.error}` : ""}`,
  });
  for (const release of project.releases) entries.push({ key: `release-${release.id}`, at: release.finished_at ?? release.created_at, status: release.status.includes("failed") || release.status === "rolled_back" ? "failed" : release.status.includes("running") ? "running" : "success", message: `リリース: ${release.status}` });
  for (const action of project.human_actions) entries.push({ key: `action-${action.id}`, at: action.completed_at ?? action.created_at, status: action.status === "completed" ? "success" : "waiting", message: action.status === "completed" ? `${actionTitle(action)}を完了しました` : `${actionTitle(action)}を待っています` });
  return entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-30);
}
