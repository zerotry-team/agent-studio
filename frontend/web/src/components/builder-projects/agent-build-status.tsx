"use client";

import type { BuilderProjectDto, HumanActionDto } from "@agent-studio/contracts";
import { Check, CheckCircle2, ChevronDown, Circle, Clock3, LoaderCircle, RefreshCw, SquareTerminal, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { approveBuilderProductionAction, completeBuilderHumanActionAction, resumeBuilderProjectAction } from "@/actions/builder-projects";
import { provisionIntegrationRepositoryAction } from "@/actions/connections";
import { builderActionDestination } from "@/components/builder-projects/action-destination";
import { presentBuilderAction } from "@/components/builder-projects/action-presentation";
import { buildEtaLabel, buildLogEntries, buildProgressPercent, buildProgressPhases, type BuildPhase } from "@/components/builder-projects/build-progress";
import { BuilderProjectStatusBadge } from "@/components/builder-projects/status";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { useSession } from "@/hooks/use-session";
import { ROLE_LABELS } from "@/lib/utils/labels";

function resumeLabel(action: HumanActionDto) {
  const condition = action.resume_condition && typeof action.resume_condition === "object" && !Array.isArray(action.resume_condition)
    ? action.resume_condition as { type?: string; topic?: string; repository_url?: string }
    : {};
  if (condition.topic?.startsWith("code_workspace:") && condition.repository_url && /github\.com\/[^/]+\/agent-studio(?:\.git)?$/i.test(condition.repository_url)) {
    return "専用Repository接続後、実装内容の確認へ進みます";
  }
  if (condition.type === "builder_answers" && condition.topic?.startsWith("code_workspace:")) {
    return "実装内容の承認後に自動再開します";
  }
  const labels: Record<string, string> = {
    builder_answers: "回答の保存後に自動再開します",
    connection_connected: "Connectionの接続テスト成功を検知すると自動再開します",
    oauth_connected: "OAuth接続の成功を検知すると自動再開します",
    browser_profile_ready: "Human Loginの成功を検知すると自動再開します",
    browser_runtime_ready: "Runtime heartbeatとTool Catalogの一致を検知すると自動再開します",
    code_workspace_runtime_ready: "Code Workspace対応Runtimeのheartbeatを検知すると自動再開します",
    github_repository_connected: "GitHub Repositoryの接続成功を検知すると自動再開します",
    git_branch_published: "専用branchとPRの検証後に自動再開します",
    git_pr_merged: "承認後にPRを反映し、GitHubの完了通知で自動再開します",
    adapter_registered: "デプロイとRuntimeへのTool登録が確認できると自動再開します",
    production_approval: "管理者の承認後に自動で本番確認へ進みます",
  };
  return condition.type ? labels[condition.type] ?? `${condition.type} を検知すると自動再開します` : "完了を確認すると自動再開します";
}

function fulfillmentLabel(mode: string | undefined) {
  return {
    model: "モデルで実行",
    reuse: "既存Toolを利用",
    configure: "接続を設定",
    shared_tool: "Agent Studio共通Toolを追加",
    organization_tool: "企業専用Runtime Toolを追加",
  }[mode ?? ""] ?? null;
}

function durationLabel(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}分${rest ? `${rest}秒` : ""}`;
  return `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
}

function clockLabel(value: string) {
  return new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function phaseDuration(phase: BuildPhase, now: number) {
  if (!phase.startedAt) return null;
  const end = phase.finishedAt ? Date.parse(phase.finishedAt) : now;
  return durationLabel(end - Date.parse(phase.startedAt));
}

function PhaseIcon({ status }: { status: BuildPhase["status"] }) {
  if (status === "completed") return <CheckCircle2 className="h-5 w-5 text-emerald-600" aria-hidden="true" />;
  if (status === "failed") return <XCircle className="h-5 w-5 text-red-600" aria-hidden="true" />;
  if (status === "running") return <LoaderCircle className="h-5 w-5 animate-spin text-sky-600" aria-hidden="true" />;
  if (status === "waiting") return <Clock3 className="h-5 w-5 text-amber-600" aria-hidden="true" />;
  return <Circle className="h-5 w-5 text-gray-300" aria-hidden="true" />;
}

function BuildProgress({ project }: { project: BuilderProjectDto }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const phases = useMemo(() => buildProgressPhases(project), [project]);
  const logs = useMemo(() => buildLogEntries(project), [project]);
  const progress = buildProgressPercent(phases);
  const current = phases.find((phase) => phase.status === "failed")
    ?? phases.find((phase) => phase.status === "waiting")
    ?? phases.find((phase) => phase.status === "running")
    ?? phases.find((phase) => phase.status === "pending")
    ?? phases.at(-1);
  const elapsed = durationLabel(now - Date.parse(project.created_at));
  const lastActivityAt = logs.at(-1)?.at ?? project.updated_at;
  const lastActivity = durationLabel(now - Date.parse(lastActivityAt));
  const failed = phases.some((phase) => phase.status === "failed");
  const completed = phases.every((phase) => phase.status === "completed");
  return <Card className="overflow-hidden">
    <CardHeader
      title="作成の進行状況"
      description={current?.detail ?? "準備しています"}
      actions={<BuilderProjectStatusBadge status={project.status} />}
    />
    <CardBody className="space-y-6" aria-live="polite">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg bg-gray-50 px-3 py-2"><p className="text-xs text-gray-500">経過時間</p><p className="mt-1 text-sm font-semibold text-gray-900">{elapsed}</p></div>
        <div className="rounded-lg bg-gray-50 px-3 py-2"><p className="text-xs text-gray-500">完了までの目安</p><p className="mt-1 text-sm font-semibold text-gray-900">{buildEtaLabel(project, now)}</p></div>
        <div className="rounded-lg bg-gray-50 px-3 py-2"><p className="text-xs text-gray-500">最終更新</p><p className="mt-1 text-sm font-semibold text-gray-900">{lastActivity === "0秒" ? "たった今" : `${lastActivity}前`}</p></div>
      </div>
      <div>
        <div className="mb-2 flex items-center justify-between text-xs text-gray-500"><span>{completed ? "すべて完了" : failed ? "処理が停止しました" : current?.label}</span><span>{progress}%</span></div>
        <div className="h-2 overflow-hidden rounded-full bg-gray-100"><div className={`h-full rounded-full transition-all duration-500 ${failed ? "bg-red-500" : completed ? "bg-emerald-500" : "bg-sky-500"}`} style={{ width: `${progress}%` }} /></div>
      </div>
      <ol className="space-y-0">
        {phases.map((phase, index) => <li key={phase.key} className="relative flex gap-3 pb-5 last:pb-0">
          {index < phases.length - 1 ? <span className={`absolute left-[9px] top-6 h-[calc(100%-1rem)] w-px ${phase.status === "completed" ? "bg-emerald-200" : "bg-gray-200"}`} /> : null}
          <span className="relative shrink-0 bg-white"><PhaseIcon status={phase.status} /></span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2"><p className={`text-sm font-medium ${phase.status === "pending" ? "text-gray-400" : "text-gray-900"}`}>{phase.label}</p>{phaseDuration(phase, now) ? <span className="font-mono text-xs text-gray-400">{phaseDuration(phase, now)}</span> : null}</div>
            <p className={`mt-0.5 text-xs leading-5 ${phase.status === "failed" ? "text-red-700" : phase.status === "waiting" ? "text-amber-700" : "text-gray-500"}`}>{phase.detail}</p>
          </div>
        </li>)}
      </ol>
      <details open className="group overflow-hidden rounded-lg bg-gray-950 text-gray-200">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium"><span className="flex items-center gap-2"><SquareTerminal className="h-4 w-4" aria-hidden="true" />リアルタイムログ</span><ChevronDown className="h-4 w-4 transition group-open:rotate-180" /></summary>
        <div className="max-h-72 overflow-y-auto border-t border-white/10 px-4 py-3 font-mono text-xs leading-6">
          {logs.map((entry) => <div key={entry.key} className="grid grid-cols-[4.5rem_1rem_minmax(0,1fr)] gap-2">
            <span className="text-gray-500">{clockLabel(entry.at)}</span>
            <span className={entry.status === "success" ? "text-emerald-400" : entry.status === "failed" ? "text-red-400" : entry.status === "waiting" ? "text-amber-400" : entry.status === "running" ? "text-sky-400" : "text-gray-500"}>{entry.status === "success" ? "✓" : entry.status === "failed" ? "×" : entry.status === "waiting" ? "!" : entry.status === "running" ? "●" : "·"}</span>
            <span className={entry.status === "failed" ? "text-red-200" : "text-gray-300"}>{entry.message}</span>
          </div>)}
        </div>
      </details>
    </CardBody>
  </Card>;
}

function NextAction({ action, projectId, projectRequest, onChanged }: { action: HumanActionDto; projectId: string; projectRequest: string; onChanged: () => Promise<void> }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const complete = useActionMutation(completeBuilderHumanActionAction, { successMessage: "回答を保存し、作成を再開しました", onSuccess: onChanged });
  const approveProduction = useActionMutation(approveBuilderProductionAction, { successMessage: "Productionへ昇格し、最終確認を開始しました", onSuccess: onChanged });
  const provisionRepository = useActionMutation(provisionIntegrationRepositoryAction, { successMessage: "企業専用Repositoryを作成しました", onSuccess: onChanged });
  const presentation = presentBuilderAction(action, projectRequest);
  const fields = presentation.fields.filter((field) => !field.secret);
  const destination = builderActionDestination(action);
  const automatic = presentation.requiresRepositoryChange || (["human_login", "aws_admin_action", "provider_app_registration", "oauth_consent", "enter_secret", "adapter_delivery"].includes(action.type) && fields.length === 0);
  const condition = action.resume_condition && typeof action.resume_condition === "object" && !Array.isArray(action.resume_condition)
    ? action.resume_condition as { repository_connection_id?: unknown }
    : {};
  const sourceRepositoryConnectionId = typeof condition.repository_connection_id === "string" ? condition.repository_connection_id : null;
  const isProductionApproval = action.type === "production_approval";
  const mergeRequested = action.type === "repository_merge" && action.response?.merge_requested === "true";
  const implementationEta = presentation.implementation ? "通常5〜15分、その後Preview確認に1〜3分かかります。" : "確認後、自動処理を再開します。";
  const missing = fields.some((field) => field.required !== false && !answers[field.name]?.trim());
  return <Card className="border-amber-200">
    <CardHeader title={presentation.title} description={presentation.reason} actions={<Badge tone="warning">担当: {ROLE_LABELS[action.assignee_role]}</Badge>} />
    <CardBody className="space-y-4">
      <Alert tone={mergeRequested ? "info" : "warning"} title={mergeRequested ? "PRを反映中です" : "現在、自動処理は停止しています"}>
        {mergeRequested ? "GitHubのmerge完了通知を受け取ると、デプロイとRuntimeへのTool登録へ自動で進みます。" : <>この確認が終わるまで先へ進みません。{implementationEta}</>}
      </Alert>
      {presentation.implementation ? <div className="space-y-4">
        <section className="rounded-lg border border-indigo-100 bg-indigo-50/60 p-4">
          <p className="text-xs font-medium text-indigo-700">完成後にできること</p>
          <p className="mt-1 text-sm leading-6 text-gray-900">{presentation.implementation.outcome}</p>
        </section>
        <div className="grid gap-3 md:grid-cols-2">
          <section className="rounded-lg border border-gray-200 p-4">
            <p className="text-xs font-medium text-gray-500">変更する場所</p>
            <p className="mt-1 text-sm font-medium text-gray-900">{presentation.implementation.destination}</p>
            <p className="mt-1 text-xs leading-5 text-gray-500">元のコードやmainへ直接変更しません。</p>
          </section>
          <section className="rounded-lg border border-gray-200 p-4">
            <p className="text-xs font-medium text-gray-500">作成するもの</p>
            <ul className="mt-1 space-y-1 text-sm text-gray-800">{presentation.implementation.changes.map((change) => <li key={change}>・{change}</li>)}</ul>
          </section>
        </div>
        {presentation.implementation.safety.length ? <section className="rounded-lg bg-gray-50 p-4"><p className="text-xs font-medium text-gray-500">安全ルール</p><ul className="mt-2 space-y-1 text-xs leading-5 text-gray-600">{presentation.implementation.safety.map((rule) => <li key={rule}>✓ {rule}</li>)}</ul></section> : null}
        <p className="text-xs text-gray-500">ボタンを押すと実装を開始します。完了後はテスト結果と変更内容をこの画面で確認できます。</p>
      </div> : <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-950">
        <p><span className="font-medium">なぜ必要か:</span> {presentation.reason}</p>
        <p className="mt-1"><span className="font-medium">自動再開:</span> {resumeLabel(action)}</p>
      </div>}
      {fields.map((field) => <Field key={field.name} label={field.label} required={field.required !== false} hint={field.description}>
        {field.options?.length ? <Select value={answers[field.name] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [field.name]: event.target.value }))}>
          <option value="">選択してください</option>
          {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Select> : <Input value={answers[field.name] ?? ""} placeholder={field.placeholder} maxLength={4000} onChange={(event) => setAnswers((current) => ({ ...current, [field.name]: event.target.value }))} />}
      </Field>)}
      {!presentation.implementation && presentation.instructions.length ? <ol className="space-y-1 text-sm text-gray-600">{presentation.instructions.map((instruction, index) => <li key={`${index}-${instruction}`}>{index + 1}. {instruction}</li>)}</ol> : null}
      <div className="flex justify-end gap-2">
        {destination === "infrastructure" ? <ButtonLink href="/settings?tab=infrastructure" variant="secondary">実行・開発基盤を設定</ButtonLink> : null}
        {presentation.requiresRepositoryChange && sourceRepositoryConnectionId ? <Button loading={provisionRepository.pending} onClick={() => provisionRepository.mutate(sourceRepositoryConnectionId)}>{presentation.primaryActionLabel}</Button> : null}
        {destination === "github" && !sourceRepositoryConnectionId ? <ButtonLink href="/settings?tab=infrastructure&connect=github" variant="secondary">{action.type === "provider_app_registration" ? presentation.primaryActionLabel : "GitHub Repositoryを接続"}</ButtonLink> : null}
        {destination === "integrations" ? <ButtonLink href="/integrations" variant="secondary">連携サービスを設定</ButtonLink> : null}
        {isProductionApproval ? <Button loading={approveProduction.pending} icon={<Check className="h-4 w-4" />} onClick={() => approveProduction.mutate(projectId)}>承認して本番で使えるようにする</Button> : !automatic && !mergeRequested ? <Button disabled={missing} loading={complete.pending} icon={<Check className="h-4 w-4" />} onClick={() => complete.mutate({ id: action.id, value: { answers } })}>{fields.length && presentation.isImplementationApproval ? `選択して${presentation.primaryActionLabel}` : presentation.primaryActionLabel}</Button> : null}
      </div>
      {complete.error ? <Alert tone="danger">{complete.error.message}</Alert> : null}
      {provisionRepository.error ? <Alert tone="danger">{provisionRepository.error.message}</Alert> : null}
      {approveProduction.error ? <Alert tone="danger">{approveProduction.error.message}</Alert> : null}
    </CardBody>
  </Card>;
}

function Details({ project }: { project: BuilderProjectDto }) {
  const latestValidation = project.validation_runs[0];
  return <details className="group rounded-xl border border-gray-200 bg-white">
    <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-sm font-medium text-gray-800">技術詳細と証跡<ChevronDown className="h-4 w-4 transition group-open:rotate-180" /></summary>
    <div className="space-y-5 border-t border-gray-100 p-5">
      {project.latest_plan ? <section><h3 className="text-sm font-semibold text-gray-900">能力計画 v{project.latest_plan.version}</h3><ol className="mt-2 space-y-2 text-sm text-gray-600">{project.latest_plan.graph.nodes.map((node) => {
        const route = fulfillmentLabel(node.fulfillment?.mode);
        return <li key={node.id} className="flex flex-wrap items-center gap-2"><span>{node.label}</span><Badge tone={node.state === "resolved" ? "success" : "warning"}>{node.state}</Badge>{route ? <Badge tone="neutral">{route}</Badge> : null}</li>;
      })}</ol></section> : null}
      <section><h3 className="text-sm font-semibold text-gray-900">変更</h3><ul className="mt-2 space-y-2 text-sm text-gray-600">{project.change_sets.map((change) => <li key={change.id}>{change.summary} <Badge tone={change.status === "applied" ? "success" : "neutral"}>{change.status}</Badge></li>)}{!project.change_sets.length ? <li>まだありません</li> : null}</ul></section>
      <section><h3 className="text-sm font-semibold text-gray-900">直近の検証</h3>{latestValidation ? <div className="mt-2 text-sm text-gray-600"><Badge tone={latestValidation.status === "passed" ? "success" : latestValidation.status === "failed" ? "danger" : "warning"}>{latestValidation.status}</Badge> {latestValidation.suite}{latestValidation.error ? <p className="mt-1 text-red-700">{latestValidation.error}</p> : null}</div> : <p className="mt-2 text-sm text-gray-500">まだありません</p>}</section>
      <section><h3 className="text-sm font-semibold text-gray-900">試行履歴</h3><ul className="mt-2 space-y-1 font-mono text-xs text-gray-500">{project.runs.map((run) => <li key={run.id}>attempt {run.attempt}: {run.status} / {run.correlation_id}</li>)}</ul></section>
    </div>
  </details>;
}

export function AgentBuildStatus({ project, onChanged }: { project: BuilderProjectDto; onChanged: () => Promise<void> }) {
  const { can } = useSession();
  const resume = useActionMutation(resumeBuilderProjectAction, { successMessage: "作成を再実行しました", onSuccess: onChanged });
  const pending = project.human_actions.find((action) => action.status === "pending");
  const release = project.releases[0];
  const canResume = can("builder.edit") && ["planning", "failed", "blocked"].includes(project.status);
  return <div className="space-y-5">
    {pending ? <NextAction action={pending} projectId={project.id} projectRequest={project.request} onChanged={onChanged} /> : null}
    <BuildProgress project={project} />
    {canResume ? <div><Button variant="secondary" loading={resume.pending} icon={<RefreshCw className="h-4 w-4" />} onClick={() => resume.mutate(project.id)}>再実行</Button></div> : null}
    {project.status === "failed" && project.runs[0]?.error ? <Alert tone="danger" title="作成処理が停止しました">{project.runs[0].error}</Alert> : null}
    {!pending ? <Alert tone={project.status === "completed" || project.status === "production_pending_approval" ? "success" : "info"}>{project.status === "completed" ? "作成とProductionの最終確認まで完了しました。" : project.status === "production_pending_approval" ? "Previewの確認が完了しました。本番で使えるようにするには管理者の承認が必要です。" : "現在、人による操作は必要ありません。処理が進むと自動で更新されます。"}</Alert> : null}
    {release ? <Card><CardHeader title="Preview到達点" description={release.status} /><CardBody className="flex flex-wrap gap-2"><ButtonLink href={`/agents/${release.agent_id}?tab=preview`}>Previewを開く</ButtonLink>{release.preview_run_id ? <ButtonLink href={`/runs/${release.preview_run_id}`} variant="primary">Run結果</ButtonLink> : null}</CardBody></Card> : null}
    <Details project={project} />
  </div>;
}
