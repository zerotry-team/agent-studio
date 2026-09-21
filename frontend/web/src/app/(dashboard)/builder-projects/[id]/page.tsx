"use client";

import type { BuilderProjectDto, HumanActionDto } from "@agent-studio/contracts";
import { Check, Circle, RefreshCw } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { approveBuilderProductionAction, completeBuilderHumanActionAction, ensureBuilderProjectAgentAction, getBuilderProjectAction, resumeBuilderProjectAction } from "@/actions/builder-projects";
import { builderActionDestination } from "@/components/builder-projects/action-destination";
import { presentBuilderAction } from "@/components/builder-projects/action-presentation";
import { BuilderProjectStatusBadge } from "@/components/builder-projects/status";
import { PageHeader } from "@/components/common/page-header";
import { QueryView } from "@/components/common/query-view";
import { TimeAgo } from "@/components/common/time-ago";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { Input, Select } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { CardSkeleton } from "@/components/ui/skeleton";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";
import { ROLE_LABELS } from "@/lib/utils/labels";

const tabs = [
  { id: "overview", label: "概要" }, { id: "plan", label: "計画" }, { id: "setup", label: "準備" },
  { id: "changes", label: "変更" }, { id: "tests", label: "テスト" }, { id: "preview", label: "Preview" },
  { id: "releases", label: "リリース" }, { id: "audit", label: "証跡" },
] as const;
type Tab = typeof tabs[number]["id"];

const strategyLabel: Record<string, string> = {
  reuse: "既存能力を再利用", configure: "接続・判断を準備", generate_declarative: "宣言的な連携を生成",
  generate_code: "隔離環境でコード生成", browser: "ブラウザ操作を生成", unsupported: "対応不可",
};

function Overview({ project }: { project: BuilderProjectDto }) {
  const currentRun = project.runs[0];
  return <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
    <Card><CardHeader title="依頼" /><CardBody><p className="whitespace-pre-wrap text-sm leading-7 text-gray-800">{project.request}</p></CardBody></Card>
    <div className="space-y-5">
      <Card><CardHeader title="現在地" /><CardBody><DescriptionList columns={1} items={[
        { label: "状態", value: <BuilderProjectStatusBadge status={project.status} /> },
        { label: "到達点", value: project.target === "preview" ? "Preview成功" : "本番候補の承認待ち" },
        { label: "不足している能力", value: `${project.gaps.filter((gap) => gap.status === "open").length}件` },
        { label: "人による準備", value: `${project.human_actions.filter((action) => action.status === "pending").length}件` },
      ]} /></CardBody></Card>
      {currentRun ? <Card><CardHeader title={`試行 ${currentRun.attempt}`} /><CardBody className="space-y-3">{currentRun.steps.map((step) => <div key={step.id} className="flex items-center gap-3 text-sm"><span className={`h-2 w-2 rounded-full ${step.status === "completed" ? "bg-emerald-500" : step.status === "failed" ? "bg-red-500" : "bg-sky-500"}`} /><span className="flex-1 text-gray-700">{step.kind === "analyze_requirements" ? "業務要件を整理" : step.kind === "resolve_capabilities" ? "必要能力を解決" : "人による準備を整理"}</span><Badge tone={step.status === "completed" ? "success" : step.status === "failed" ? "danger" : "neutral"}>{step.status}</Badge></div>)}</CardBody></Card> : null}
    </div>
  </div>;
}

function Plan({ project }: { project: BuilderProjectDto }) {
  const plan = project.latest_plan;
  if (!plan) return <Alert title="計画を作成中です">依頼の整理が終わると、必要な能力と解決方法がここに表示されます。</Alert>;
  return <div className="space-y-5">
    <Card><CardHeader title={`能力計画 v${plan.version}`} description="APIを優先し、不足能力だけを生成対象にしています。" /><CardBody className="space-y-1">{plan.graph.nodes.map((node, index) => <div key={node.id} className="relative flex gap-4 pb-5 last:pb-0">{index < plan.graph.nodes.length - 1 ? <span className="absolute left-[7px] top-4 h-full w-px bg-gray-200" /> : null}<Circle className={`relative mt-1 h-4 w-4 shrink-0 ${node.state === "resolved" ? "fill-emerald-500 text-emerald-500" : "fill-white text-amber-500"}`} /><div><p className="text-sm font-medium text-gray-900">{node.label}</p><p className="mt-1 text-xs text-gray-500">{strategyLabel[node.strategy] ?? node.strategy}</p></div></div>)}</CardBody></Card>
    {project.gaps.length ? <Card><CardHeader title="不足能力" /><CardBody className="space-y-3">{project.gaps.map((gap) => <div key={gap.id} className="rounded-lg border border-gray-200 p-4"><div className="flex flex-wrap items-center gap-2"><p className="font-medium text-gray-900">{gap.requirement}</p><Badge tone={gap.gap_type === "needs_connection" ? "warning" : "neutral"}>{gap.gap_type}</Badge></div><p className="mt-2 text-sm text-gray-500">{strategyLabel[gap.resolution_strategy]}</p></div>)}</CardBody></Card> : null}
  </div>;
}

function HumanActionCard({ action, projectRequest, pending, onComplete }: { action: HumanActionDto; projectRequest: string; pending: boolean; onComplete: (id: string, answers: Record<string, string>) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const presentation = presentBuilderAction(action, projectRequest);
  const answerFields = presentation.fields.filter((field) => !field.secret);
  const complete = () => onComplete(action.id, answers);
  const missing = answerFields.some((field) => field.required !== false && !answers[field.name]?.trim());
  const isConnection = ["enter_secret", "provider_app_registration", "oauth_consent"].includes(action.type);
  const isHumanLogin = action.type === "human_login";
  const automaticType = action.resume_condition && typeof action.resume_condition === "object" && !Array.isArray(action.resume_condition)
    ? (action.resume_condition as { type?: unknown }).type
    : undefined;
  const isBrowserRuntime = automaticType === "browser_runtime_ready";
  const isWorkspaceRuntime = automaticType === "code_workspace_runtime_ready";
  const isGitPublish = automaticType === "git_branch_published";
  const destination = builderActionDestination(action);
  const isAutoDetected = isHumanLogin || isBrowserRuntime || isWorkspaceRuntime || isGitPublish;
  return <Card className="border-amber-200">
    <CardHeader title={presentation.title} description={presentation.reason} actions={<Badge tone="warning">{ROLE_LABELS[action.assignee_role]}</Badge>} />
    <CardBody className="space-y-4">
      {answerFields.length ? <div className="space-y-4 rounded-lg bg-amber-50/60 p-4">{answerFields.map((field) => <Field key={field.name} label={field.label} required={field.required !== false} hint={field.description}>
        {field.options?.length ? <Select value={answers[field.name] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [field.name]: event.target.value }))}>
          <option value="">選択してください</option>
          {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Select> : <Input value={answers[field.name] ?? ""} placeholder={field.placeholder} maxLength={4000} onChange={(event) => setAnswers((current) => ({ ...current, [field.name]: event.target.value }))} />}
      </Field>)}</div> : null}
      <ol className="space-y-2 text-sm text-gray-700">{presentation.instructions.map((instruction, index) => <li key={`${index}-${instruction}`} className="flex gap-3"><span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-medium">{index + 1}</span>{instruction}</li>)}</ol>
      <div className="flex flex-wrap justify-end gap-2">
        {destination === "infrastructure" ? <ButtonLink href="/settings?tab=infrastructure">実行・開発基盤を設定</ButtonLink> : null}
        {destination === "github" ? <ButtonLink href="/settings?tab=infrastructure&connect=github">GitHub Repositoryを接続</ButtonLink> : null}
        {destination === "integrations" ? <ButtonLink href="/integrations">連携サービスを設定</ButtonLink> : null}
        {isHumanLogin ? <span className="text-xs text-amber-700">Browser Profileのログイン検証後に自動再開します</span> : null}
        {isBrowserRuntime ? <span className="text-xs text-amber-700">RuntimeのHeartbeatとTool Catalog検証後に自動再開します</span> : null}
        {isWorkspaceRuntime ? <span className="text-xs text-amber-700">Code Workspace対応RuntimeのHeartbeat検証後に自動再開します</span> : null}
        {isGitPublish ? <span className="text-xs text-amber-700">branch pushとPR作成の検証後に自動再開します</span> : null}
        {action.type === "production_approval" ? <ButtonLink href="#builder-project-releases-tab">リリースで確認</ButtonLink> : !isConnection && !isAutoDetected ? <Button disabled={missing} loading={pending} icon={<Check className="h-4 w-4" />} onClick={complete}>{answerFields.length && presentation.isImplementationApproval ? `選択して${presentation.primaryActionLabel}` : presentation.primaryActionLabel}</Button> : null}
      </div>
    </CardBody>
  </Card>;
}

function Setup({ project, onUpdate }: { project: BuilderProjectDto; onUpdate: (project: BuilderProjectDto) => void }) {
  const mutation = useActionMutation(completeBuilderHumanActionAction, {
    successMessage: (updated) => updated.status === "draft" ? "準備完了を記録し、自動再開しました" : "準備完了を記録しました",
    onSuccess: onUpdate,
  });
  const pending = project.human_actions.filter((action) => action.status === "pending");
  if (!pending.length) return <Alert tone="success" title="人による準備はありません">技術的な調査と生成は自動で進めます。</Alert>;
  return <div className="space-y-4">{pending.map((action) => <HumanActionCard key={action.id} action={action} projectRequest={project.request} pending={mutation.pending} onComplete={(id, answers) => mutation.mutate({ id, value: { answers } })} />)}</div>;
}

function PhaseNotice({ title, children }: { title: string; children: string }) {
  return <Card><CardHeader title={title} /><CardBody><p className="text-sm leading-6 text-gray-600">{children}</p></CardBody></Card>;
}

function Changes({ project }: { project: BuilderProjectDto }) {
  const artifactLabels: Record<string, string> = {
    capability_topic: "対象能力", repository: "Repository", base_branch: "基点branch", git_branch: "専用branch",
    isolated_workspace: "隔離workspace", adapter_target: "生成先", connector: "Connector", tool: "Tool",
    allowed_domain: "許可ドメイン", browser_mode: "Browser mode", browser_step: "操作",
  };
  return <div className="space-y-5">
    {project.change_sets.length ? <Card><CardHeader title="生成済みの変更" description="Connector、Tool、Code Workspace、Buildを再現できる単位で固定しています。" /><CardBody className="space-y-4">{project.change_sets.map((change) => <div key={change.id} className="rounded-lg border border-gray-200 p-4"><div className="flex flex-wrap items-center gap-2"><p className="font-medium text-gray-900">{change.summary}</p><Badge tone={change.status === "applied" ? "success" : change.status === "planned" ? "warning" : "neutral"}>{change.status}</Badge><Badge tone={change.risk === "read" ? "success" : change.risk === "write" ? "warning" : "danger"}>{change.risk}</Badge></div><div className="mt-3 flex flex-wrap gap-2">{change.artifacts.map((artifact) => <span key={`${artifact.type}:${artifact.id}`} className="rounded-md bg-gray-100 px-2 py-1 text-xs text-gray-600">{artifactLabels[artifact.type] ?? artifact.type}: {artifact.name}{artifact.version ? ` v${artifact.version}` : ""}</span>)}</div><p className="mt-3 font-mono text-[11px] text-gray-400">source {change.source_hash?.slice(0, 16)}</p></div>)}</CardBody></Card> : <PhaseNotice title="生成済みの変更">必要な連携や実装が確定すると、安全な変更単位をここへ固定します。</PhaseNotice>}
  </div>;
}

function Tests({ project }: { project: BuilderProjectDto }) {
  if (!project.validation_runs.length) return <PhaseNotice title="検証結果">生成物ができると、契約・セキュリティ・実接続・Previewの検証結果をここへ固定します。</PhaseNotice>;
  return <Card><CardHeader title="検証結果" description="HTTP 200だけではなく、検証した境界と生成Versionを証拠として残します。" /><CardBody className="space-y-4">{project.validation_runs.map((validation) => <div key={validation.id} className="rounded-lg border border-gray-200 p-4"><div className="flex flex-wrap items-center gap-2"><p className="font-medium text-gray-900">{validation.suite}</p><Badge tone={validation.status === "passed" ? "success" : validation.status === "failed" ? "danger" : "warning"}>{validation.status}</Badge><Badge tone="neutral">{validation.environment}</Badge></div>{validation.error ? <p className="mt-2 text-sm text-red-700">{validation.error}</p> : null}<pre className="mt-3 overflow-x-auto rounded-md bg-gray-50 p-3 text-xs leading-5 text-gray-600">{JSON.stringify(validation.evidence, null, 2)}</pre></div>)}</CardBody></Card>;
}

function Preview({ project }: { project: BuilderProjectDto }) {
  if (!project.releases.length) return <PhaseNotice title="Preview">必要な能力と接続が揃った後、Immutable Buildを作成し、実際のRunで生成した操作が成功するまで確認します。</PhaseNotice>;
  return <div className="space-y-4">{project.releases.map((release) => {
    const succeeded = release.status === "preview_succeeded";
    const failed = release.status === "preview_failed";
    const cancelled = release.status === "preview_cancelled";
    return <Card key={release.id} className={succeeded ? "border-emerald-200" : failed ? "border-red-200" : "border-sky-200"}>
      <CardHeader
        title={succeeded ? "Preview受け入れ成功" : failed ? "Preview受け入れ失敗" : cancelled ? "Previewは中止されました" : "Preview Runを実行中"}
        description="Runの終了だけでなく、生成した読み取り操作の成功イベントまで確認します。"
        actions={<Badge tone={succeeded ? "success" : failed ? "danger" : cancelled ? "neutral" : "info"}>{release.status}</Badge>}
      />
      <CardBody className="space-y-4">
        <DescriptionList columns={2} items={[
          { label: "Build", value: release.build_id },
          { label: "Deployment", value: release.preview_deployment_id },
          { label: "構成ハッシュ", value: <span className="font-mono text-xs">{release.config_hash.slice(0, 20)}</span> },
          { label: "完了時刻", value: release.finished_at ?? "実行中" },
        ]} />
        <div className="flex flex-wrap justify-end gap-2">
          <ButtonLink href={`/agents/${release.agent_id}?tab=preview`} size="sm">Agent Preview</ButtonLink>
          {release.preview_run_id ? <ButtonLink href={`/runs/${release.preview_run_id}`} size="sm" variant="primary">Run詳細</ButtonLink> : null}
        </div>
      </CardBody>
    </Card>;
  })}</div>;
}

function Releases({ project, onUpdate, canApprove }: { project: BuilderProjectDto; onUpdate: (project: BuilderProjectDto) => void; canApprove: boolean }) {
  const approve = useActionMutation(approveBuilderProductionAction, { successMessage: "同一BuildをProductionへ昇格し、限定Runを開始しました", onSuccess: onUpdate });
  if (!project.releases.length) return <PhaseNotice title="リリース">Preview成功後、その同一Buildを本番候補として固定します。</PhaseNotice>;
  return <div className="space-y-4">{project.releases.map((release) => {
    const pending = release.status === "production_pending_approval";
    const success = release.status === "production_succeeded";
    const failure = release.status === "production_failed" || release.status === "rolled_back";
    return <Card key={release.id} className={success ? "border-emerald-200" : failure ? "border-red-200" : pending ? "border-amber-200" : undefined}>
      <CardHeader title={pending ? "Production承認待ち" : success ? "Production確認完了" : release.status === "rolled_back" ? "自動Rollback完了" : "リリース候補"} description="Previewで検証した構成ハッシュの同一Buildだけを昇格します。" actions={<Badge tone={success ? "success" : failure ? "danger" : pending ? "warning" : "neutral"}>{release.status}</Badge>} />
      <CardBody className="space-y-4"><DescriptionList columns={2} items={[
        { label: "Build", value: release.build_id },
        { label: "構成ハッシュ", value: <span className="font-mono text-xs">{release.config_hash.slice(0, 20)}</span> },
        { label: "Production Deployment", value: release.production_deployment_id ?? "未昇格" },
        { label: "Rollback先", value: release.rollback_target_deployment_id ?? "なし" },
      ]} /><div className="flex flex-wrap justify-end gap-2">{release.production_run_id ? <ButtonLink href={`/runs/${release.production_run_id}`} size="sm">限定Run詳細</ButtonLink> : null}{pending && canApprove ? <Button loading={approve.pending} onClick={() => approve.mutate(project.id)}>承認してProductionへ昇格</Button> : null}</div></CardBody>
    </Card>;
  })}</div>;
}

function Project({ project, setProject }: { project: BuilderProjectDto; setProject: (project: BuilderProjectDto) => void }) {
  const { can } = useSession();
  const [tab, setTab] = useState<Tab>("overview");
  const resume = useActionMutation(resumeBuilderProjectAction, { successMessage: "再実行を開始しました", onSuccess: setProject });
  const canResume = can("builder.edit") && ["planning", "failed", "blocked"].includes(project.status);
  return <>
    <PageHeader title="作成プロジェクト" description={<span>更新 <TimeAgo value={project.updated_at} /></span>} back={{ href: "/builder-projects", label: "作成プロジェクト" }} meta={<BuilderProjectStatusBadge status={project.status} />} actions={canResume ? <Button variant="secondary" loading={resume.pending} icon={<RefreshCw className="h-4 w-4" />} onClick={() => resume.mutate(project.id)}>再実行</Button> : undefined} />
    {project.status === "failed" && project.runs[0]?.error ? <Alert tone="danger" title="計画処理が停止しました" className="mb-5">{project.runs[0].error}</Alert> : null}
    <Tabs tabs={tabs} value={tab} onChange={setTab} label="作成プロジェクト" idPrefix="builder-project" />
    <TabPanel id="overview" value={tab} idPrefix="builder-project"><Overview project={project} /></TabPanel>
    <TabPanel id="plan" value={tab} idPrefix="builder-project"><Plan project={project} /></TabPanel>
    <TabPanel id="setup" value={tab} idPrefix="builder-project"><Setup project={project} onUpdate={setProject} /></TabPanel>
    <TabPanel id="changes" value={tab} idPrefix="builder-project"><Changes project={project} /></TabPanel>
    <TabPanel id="tests" value={tab} idPrefix="builder-project"><Tests project={project} /></TabPanel>
    <TabPanel id="preview" value={tab} idPrefix="builder-project"><Preview project={project} /></TabPanel>
    <TabPanel id="releases" value={tab} idPrefix="builder-project"><Releases project={project} onUpdate={setProject} canApprove={can("deployment.production")} /></TabPanel>
    <TabPanel id="audit" value={tab} idPrefix="builder-project"><Card><CardHeader title="試行履歴" /><CardBody className="space-y-4">{project.runs.map((run) => <div key={run.id} className="flex items-center gap-3 border-b border-gray-100 pb-4 last:border-0 last:pb-0"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 text-sm font-semibold">{run.attempt}</span><div className="min-w-0 flex-1"><p className="text-sm font-medium text-gray-900">相関ID {run.correlation_id}</p><p className="text-xs text-gray-500">{run.created_at}</p></div><Badge tone={run.status === "completed" ? "success" : run.status === "failed" ? "danger" : "neutral"}>{run.status}</Badge></div>)}</CardBody></Card></TabPanel>
  </>;
}

export default function BuilderProjectPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const migrationStarted = useRef(false);
  const query = useActionQuery(() => getBuilderProjectAction(params.id), [params.id], {
    refetchInterval: (project) => project && ["draft", "analyzing", "discovering", "implementing", "validating", "previewing"].includes(project.status) ? 2_000 : false,
  });
  const migrate = useActionMutation(ensureBuilderProjectAgentAction, {
    onSuccess: (project) => {
      if (project.agent_id) router.replace(`/agents/${project.agent_id}?tab=build`);
    },
  });
  useEffect(() => {
    if (!query.data || migrationStarted.current) return;
    if (query.data.agent_id) {
      router.replace(`/agents/${query.data.agent_id}?tab=build`);
      return;
    }
    migrationStarted.current = true;
    void migrate.mutate(query.data.id);
  }, [query.data, router, migrate]);
  if (query.data?.agent_id || migrationStarted.current) {
    return <div className="space-y-5"><PageHeader title="Agentへ移行しています" back={{ href: "/agents", label: "Agent一覧" }} /><Alert tone={migrate.error ? "danger" : "info"}>{migrate.error?.message ?? "同じ作成状態をAgent詳細で開きます。"}</Alert></div>;
  }
  return <QueryView query={query} loading={<div className="space-y-5"><CardSkeleton /><CardSkeleton /></div>}>
    {(project) => <Project project={project} setProject={(next) => query.setData(next)} />}
  </QueryView>;
}
