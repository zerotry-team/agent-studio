"use client";

import type { AgentProjectDto, ConnectionDto, ConnectorDto, DeploymentDto, Stage } from "@agent-studio/contracts";
import { CalendarClock, Check, CircleAlert, CloudUpload, History, Link2, MessageSquare, Rocket, RotateCcw, Settings, Trash2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import {
  createPreviewAction,
  getAgentProjectAction,
  linkAgentConnectionAction,
  setAgentEnvironmentAction,
} from "@/actions/agents";
import { listConnectionsAction } from "@/actions/connections";
import { listConnectorsAction } from "@/actions/connectors";
import { listDeploymentsAction, promoteDeploymentAction, rollbackDeploymentAction } from "@/actions/deployments";
import { createScheduleAction, deleteScheduleAction, listSchedulesAction, updateScheduleAction } from "@/actions/schedules";
import { AgentRun } from "@/components/agents/agent-run";
import { ErrorState } from "@/components/common/error-state";
import { PageHeader } from "@/components/common/page-header";
import { StageBadge } from "@/components/common/status-badges";
import { TimeAgo } from "@/components/common/time-ago";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";

const PROJECT_TABS = ["overview", "preview", "deployments", "runs", "settings"] as const;
type ProjectTab = (typeof PROJECT_TABS)[number];
const TAB_LABELS: Record<ProjectTab, string> = {
  overview: "Overview",
  preview: "Preview",
  deployments: "Deployments",
  runs: "Runs",
  settings: "Settings",
};

function parseTab(value: string | null): ProjectTab {
  return PROJECT_TABS.find((tab) => tab === value) ?? "overview";
}

export default function AgentProjectPage({ params }: { params: { id: string } }) {
  const { organization } = useSession();
  const searchParams = useSearchParams();
  const urlTab = parseTab(searchParams.get("tab"));
  const [tab, setTab] = useState<ProjectTab>(urlTab);
  useEffect(() => setTab(urlTab), [urlTab]);
  const project = useActionQuery(() => getAgentProjectAction(params.id), [params.id, organization?.id]);

  const changeTab = (next: ProjectTab) => {
    setTab(next);
    const query = new URLSearchParams(window.location.search);
    if (next === "overview") query.delete("tab");
    else query.set("tab", next);
    window.history.replaceState(null, "", `${window.location.pathname}${query.size ? `?${query}` : ""}`);
  };

  if (!project.data) {
    if (project.error) return <ErrorState message={project.error.message} onRetry={project.reload} retrying={project.refreshing} />;
    return <><Skeleton className="h-8 w-64" /><SkeletonText className="mt-6" lines={8} /></>;
  }
  const data = project.data;
  const preview = data.deployments.find((deployment) => deployment.stage === "staging" && deployment.status === "active");
  const production = data.deployments.find((deployment) => deployment.stage === "production" && deployment.status === "active");

  return (
    <>
      <PageHeader
        title={data.agent.name}
        back={{ href: "/agents", label: "Agent一覧" }}
        description={data.agent.description ?? data.agent.project_brief ?? undefined}
        meta={<div className="flex gap-2"><EnvironmentBadge label="Production" deployment={production} /><EnvironmentBadge label="Preview" deployment={preview} /></div>}
        actions={preview ? <Button onClick={() => changeTab("preview")} icon={<MessageSquare className="h-4 w-4" />}>Previewで試す</Button> : undefined}
      />
      <Tabs
        label="Agent Project"
        idPrefix="project"
        value={tab}
        onChange={changeTab}
        tabs={PROJECT_TABS.map((id) => ({ id, label: TAB_LABELS[id] }))}
      />
      <TabPanel id="overview" value={tab} idPrefix="project">
        <Overview project={data} onChanged={project.reload} onGoTo={changeTab} />
      </TabPanel>
      <TabPanel id="preview" value={tab} idPrefix="project">
        <Preview project={data} />
      </TabPanel>
      <TabPanel id="deployments" value={tab} idPrefix="project">
        <Deployments project={data} onChanged={project.reload} />
      </TabPanel>
      <TabPanel id="runs" value={tab} idPrefix="project">
        <Card><CardHeader title="Runs" description="Build、Run、操作、承認、エラーを相関して確認できます。" /><CardBody><ButtonLink href="/runs" variant="secondary" icon={<History className="h-4 w-4" />}>実行履歴を開く</ButtonLink></CardBody></Card>
      </TabPanel>
      <TabPanel id="settings" value={tab} idPrefix="project">
        <ProjectSettings project={data} onChanged={project.reload} />
      </TabPanel>
    </>
  );
}

function EnvironmentBadge({ label, deployment }: { label: string; deployment?: DeploymentDto }) {
  const health = deployment?.health_status;
  const healthLabel = health === "ready" ? "Ready" : health === "degraded" ? "Degraded" : health === "failed" ? "Failed" : "未公開";
  return <Badge tone={health === "ready" ? "success" : health === "degraded" || health === "failed" ? "warning" : "neutral"} dot={Boolean(deployment)}>{label} {healthLabel}</Badge>;
}

function Overview({ project, onChanged, onGoTo }: { project: AgentProjectDto; onChanged: () => Promise<void>; onGoTo: (tab: ProjectTab) => void }) {
  const createPreview = useActionMutation(createPreviewAction, { successMessage: "Previewを作成しました", onSuccess: onChanged });
  const resolution = project.agent.capability_resolution;
  return (
    <div className="grid gap-6 lg:grid-cols-[1.3fr_.7fr]">
      <Card>
        <CardHeader title="Agentを準備しています" description="必要な項目だけを表示しています。" />
        <CardBody className="space-y-3">
          {resolution.requirements.map((requirement, index) => (
            <div key={`${requirement.requirement}-${index}`} className="flex items-start justify-between gap-4 rounded-lg border border-gray-100 px-3 py-3">
              <div className="flex min-w-0 items-start gap-2.5">
                {requirement.state === "resolved" ? <Check className="mt-0.5 h-4 w-4 text-emerald-600" /> : <CircleAlert className="mt-0.5 h-4 w-4 text-amber-600" />}
                <div><p className="text-sm font-medium text-gray-900">{requirement.requirement}</p><p className="mt-0.5 text-xs text-gray-500">{requirement.connector_name ?? requirement.reason}</p></div>
              </div>
              <Badge tone={requirement.state === "resolved" ? "success" : "warning"}>{requirement.state === "resolved" ? "準備済み" : requirement.state === "needs_connection" ? "Connectionが必要" : "確認が必要"}</Badge>
            </div>
          ))}
          {resolution.missing_variables.map((name) => (
            <div key={name} className="flex items-center justify-between rounded-lg border border-amber-100 bg-amber-50/50 px-3 py-3 text-sm"><span>{name}を設定してください</span><Badge tone="warning">Variableが必要</Badge></div>
          ))}
          {resolution.requirements.length === 0 && resolution.missing_variables.length === 0 ? <Alert tone="info">外部連携なしで実行できるAgentです。</Alert> : null}
          {createPreview.error ? <Alert tone="danger">{createPreview.error.message}</Alert> : null}
          <div className="flex flex-wrap gap-2 pt-2">
            {resolution.ready ? (
              <Button onClick={() => void createPreview.mutate(project.agent.id)} loading={createPreview.pending} icon={<CloudUpload className="h-4 w-4" />}>Previewを作成</Button>
            ) : (
              <Button onClick={() => onGoTo("settings")} icon={<Settings className="h-4 w-4" />}>不足項目を設定</Button>
            )}
          </div>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="概要" />
        <CardBody className="space-y-4 text-sm">
          <SummaryRow label="Connections" value={[...new Set(project.connection_links.map((link) => link.connector.name))].join(" / ") || "なし"} />
          <SummaryRow label="Latest Build" value={project.builds[0] ? `Build ${project.builds[0].build_number}` : "未作成"} />
          <SummaryRow label="Production" value={project.deployments.some((deployment) => deployment.stage === "production" && deployment.status === "active") ? "Ready" : "未公開"} />
          <SummaryRow label="公開方法" value="Chat / API / Schedule" />
          {project.preview_api_url ? <div className="space-y-1 border-t border-gray-100 pt-3"><p className="text-xs text-gray-500">Preview API</p><code className="block overflow-x-auto rounded-md bg-gray-50 px-2 py-1.5 text-xs text-gray-700">POST {project.preview_api_url}</code></div> : null}
        </CardBody>
      </Card>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-4 border-b border-gray-100 pb-3 last:border-0"><span className="text-gray-500">{label}</span><span className="text-right font-medium text-gray-900">{value}</span></div>;
}

function Preview({ project }: { project: AgentProjectDto }) {
  const { organization } = useSession();
  const deployments = useActionQuery(() => listDeploymentsAction({ agent_id: project.agent.id }), [project.agent.id, organization?.id]);
  const preview = project.deployments.find((deployment) => deployment.stage === "staging" && deployment.status === "active");
  if (!preview) return <Card><CardBody><Alert tone="info" title="Previewはまだありません">Overviewで不足項目を設定し、Previewを作成してください。</Alert></CardBody></Card>;
  return (
    <div className="space-y-5">
      <Alert tone="info" title={`Build ${preview.build_number ?? "—"} のPreview`}>
        外部更新はPolicyに従って承認待ちになります。承認前にSNS投稿は実行されません。
      </Alert>
      {project.preview_api_url ? <Alert tone="info" title="APIから試す"><code className="break-all text-xs">POST {project.preview_api_url}</code></Alert> : null}
      <AgentRun deployments={deployments} onGoToTab={() => undefined} />
    </div>
  );
}

function Deployments({ project, onChanged }: { project: AgentProjectDto; onChanged: () => Promise<void> }) {
  const { organization } = useSession();
  const connectors = useActionQuery(() => listConnectorsAction(), [organization?.id]);
  const [promoteTarget, setPromoteTarget] = useState<DeploymentDto | null>(null);
  const promote = useActionMutation(promoteDeploymentAction, { successMessage: "同じBuildをProductionへ公開しました", onSuccess: onChanged });
  const rollback = useActionMutation(rollbackDeploymentAction, { successMessage: "ProductionをRollbackしました", onSuccess: onChanged });
  const previewLinks = project.connection_links.filter((link) => link.stage === "staging");
  const productionLinks = project.connection_links.filter((link) => link.stage === "production");
  const previewPermissions = new Set(previewLinks.flatMap((link) => link.allowed_capabilities.map((name) => `${link.connector.id}:${name}`)));
  const productionPermissions = productionLinks.flatMap((link) => link.allowed_capabilities.map((name) => ({ connectorId: link.connector.id, connectorName: link.connector.name, name })));
  const permissionAdditions = productionPermissions.filter((permission) => !previewPermissions.has(`${permission.connectorId}:${permission.name}`));
  const riskOperations = productionPermissions.flatMap((permission) => {
    const tool = connectors.data?.find((connector) => connector.id === permission.connectorId)?.tools.find((item) => item.name === permission.name);
    return tool && tool.risk !== "read" ? [{ ...permission, risk: tool.risk }] : [];
  });
  return (
    <Card>
      <CardHeader title="Deployments" description="Previewで検証したImmutable BuildをProductionへ昇格できます。" />
      <CardBody className="space-y-3">
        {project.deployments.map((deployment) => (
          <div key={deployment.id} className="rounded-xl border border-gray-200 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div><div className="flex flex-wrap items-center gap-2"><StageBadge stage={deployment.stage} /><span className="font-medium text-gray-900">Build {deployment.build_number ?? "Legacy"}</span><Badge tone={deployment.status === "active" ? "success" : "neutral"}>{deployment.status}</Badge><EnvironmentBadge label="Health" deployment={deployment} /></div><p className="mt-1 text-xs text-gray-500">{deployment.id} · <TimeAgo value={deployment.created_at} /></p></div>
              <div className="flex gap-2">
              {deployment.stage === "staging" && deployment.status === "active" ? <Button size="sm" onClick={() => setPromoteTarget(deployment)} icon={<Rocket className="h-4 w-4" />}>Productionへ公開</Button> : null}
              {deployment.stage === "production" && deployment.status !== "active" && deployment.build_id ? <Button size="sm" variant="secondary" onClick={() => void rollback.mutate(deployment.id)} loading={rollback.pending} icon={<RotateCcw className="h-4 w-4" />}>Rollback</Button> : null}
              </div>
            </div>
            {deployment.build_id ? (() => { const build = project.builds.find((item) => item.id === deployment.build_id); return build ? <details className="mt-3 border-t border-gray-100 pt-3"><summary className="cursor-pointer text-xs font-medium text-gray-600">Buildログを表示</summary><ol className="mt-2 space-y-1">{build.build_log.map((entry, index) => <li key={`${entry.message}-${index}`} className="text-xs text-gray-600"><span className="mr-2 font-medium uppercase text-gray-400">{entry.type}</span>{entry.message}</li>)}</ol></details> : null; })() : null}
          </div>
        ))}
        {project.deployments.length === 0 ? <p className="py-8 text-center text-sm text-gray-500">Deploymentはまだありません。</p> : null}
        {promote.error || rollback.error ? <Alert tone="danger">{promote.error?.message ?? rollback.error?.message}</Alert> : null}
      </CardBody>
      <ConfirmDialog
        open={Boolean(promoteTarget)}
        onClose={() => setPromoteTarget(null)}
        title="Preview BuildをProductionへ公開しますか？"
        description={promoteTarget ? `Build ${promoteTarget.build_number}を再生成せず、そのままProductionへ昇格します。` : undefined}
        confirmLabel="Productionへ公開"
        onConfirm={async () => {
          if (!promoteTarget) return false;
          const result = await promote.mutate(promoteTarget.id);
          if (!result.ok) return false;
        }}
      >
        <div className="space-y-3">
          <Alert tone="warning">公開投稿など外部へ影響する操作は、Productionでも承認必須のままです。</Alert>
          <div className="rounded-lg border border-gray-200 p-3 text-sm">
            <p className="font-medium text-gray-900">Production Connection</p>
            <p className="mt-1 text-gray-600">{productionLinks.map((link) => `${link.connector.name}: ${link.connection.name}`).join(" / ") || "未設定"}</p>
          </div>
          <div className="rounded-lg border border-gray-200 p-3 text-sm">
            <p className="font-medium text-gray-900">権限差分</p>
            <p className="mt-1 text-gray-600">{permissionAdditions.length ? `Previewより追加: ${permissionAdditions.map((item) => item.name).join(", ")}` : "Previewから追加される権限はありません"}</p>
          </div>
          {riskOperations.length ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm"><p className="font-medium text-amber-900">承認対象の操作</p><ul className="mt-1 space-y-1 text-amber-800">{riskOperations.map((item) => <li key={`${item.connectorId}:${item.name}`}>{item.connectorName}: {item.name} ({item.risk})</li>)}</ul></div> : null}
        </div>
      </ConfirmDialog>
    </Card>
  );
}

function ProjectSettings({ project, onChanged }: { project: AgentProjectDto; onChanged: () => Promise<void> }) {
  const { organization } = useSession();
  const connectors = useActionQuery(() => listConnectorsAction(), [organization?.id]);
  const connections = useActionQuery(() => listConnectionsAction(), [organization?.id]);
  return (
    <div className="space-y-6">
      <ConnectionSettings project={project} connectors={connectors.data ?? []} connections={connections.data ?? []} onChanged={onChanged} />
      <VariableSettings project={project} onChanged={onChanged} />
      <ScheduleSettings agentId={project.agent.id} />
      <Card>
        <CardHeader title="Advanced Manifest" description="通常は編集不要です。能力・Policy・Environmentの内部定義を確認できます。" />
        <CardBody><details><summary className="cursor-pointer text-sm font-medium text-gray-700">Manifestを表示</summary><pre className="mt-3 overflow-auto rounded-lg bg-gray-950 p-4 text-xs text-gray-100">{project.agent.versions?.[0]?.manifest_yaml}</pre></details></CardBody>
      </Card>
    </div>
  );
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function ScheduleSettings({ agentId }: { agentId: string }) {
  const { organization } = useSession();
  const schedules = useActionQuery(() => listSchedulesAction(agentId), [agentId, organization?.id]);
  const [name, setName] = useState("SNS分析と投稿案作成");
  const [stage, setStage] = useState<Stage>("staging");
  const [localTime, setLocalTime] = useState("09:00");
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [input, setInput] = useState("ベンチマークを分析し、今日のSNS投稿案を作成してください。公開投稿は行わないでください。");
  const create = useActionMutation(createScheduleAction, { successMessage: "Scheduleを作成しました", onSuccess: schedules.reload });
  const update = useActionMutation(updateScheduleAction, { successMessage: "Scheduleを更新しました", onSuccess: schedules.reload });
  const remove = useActionMutation(deleteScheduleAction, { successMessage: "Scheduleを削除しました", onSuccess: schedules.reload });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void create.mutate(agentId, { name, stage, input, timezone: "Asia/Tokyo", local_time: localTime, days_of_week: days, enabled: true });
  };
  return (
    <Card>
      <CardHeader title="Schedule" description="決まった曜日・時刻に、ReadyなPreviewまたはProductionを自動実行します。" />
      <CardBody className="space-y-5">
        {schedules.data?.map((schedule) => (
          <div key={schedule.id} className="flex flex-col gap-3 rounded-xl border border-gray-200 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2"><CalendarClock className="h-4 w-4 text-gray-500" /><span className="font-medium text-gray-900">{schedule.name}</span><StageBadge stage={schedule.stage} /><Badge tone={schedule.enabled ? "success" : "neutral"}>{schedule.enabled ? "有効" : "停止中"}</Badge></div>
              <p className="mt-1 text-xs text-gray-500">{schedule.days_of_week.map((day) => WEEKDAYS[day]).join("・")} {schedule.local_time}（日本時間） · 次回 {new Date(schedule.next_run_at).toLocaleString("ja-JP")}</p>
              <p className="mt-1 truncate text-sm text-gray-600">{schedule.input}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" variant="secondary" loading={update.pending} onClick={() => void update.mutate(schedule.id, { enabled: !schedule.enabled })}>{schedule.enabled ? "停止" : "再開"}</Button>
              <Button size="sm" variant="ghost" loading={remove.pending} icon={<Trash2 className="h-4 w-4" />} onClick={() => void remove.mutate(schedule.id)}>削除</Button>
            </div>
          </div>
        ))}
        <form onSubmit={submit} className="space-y-4 rounded-xl bg-gray-50 p-4">
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="名前" required><Input value={name} onChange={(event) => setName(event.target.value)} /></Field>
            <Field label="環境" required><Select value={stage} onChange={(event) => setStage(event.target.value as Stage)}><option value="staging">Preview</option><option value="production">Production</option></Select></Field>
            <Field label="実行時刻（日本時間）" required><Input type="time" value={localTime} onChange={(event) => setLocalTime(event.target.value)} /></Field>
          </div>
          <Field label="曜日" required>
            <div className="flex flex-wrap gap-2">{WEEKDAYS.map((label, day) => <label key={label} className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"><input type="checkbox" checked={days.includes(day)} onChange={(event) => setDays((current) => event.target.checked ? [...current, day].sort() : current.filter((value) => value !== day))} />{label}</label>)}</div>
          </Field>
          <Field label="毎回の指示" required><textarea className="min-h-24 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-100" value={input} onChange={(event) => setInput(event.target.value)} /></Field>
          <Button type="submit" size="sm" disabled={days.length === 0 || !input.trim()} loading={create.pending} icon={<CalendarClock className="h-4 w-4" />}>Scheduleを作成</Button>
          {create.error || update.error || remove.error ? <p className="text-xs text-red-600">{create.error?.message ?? update.error?.message ?? remove.error?.message}</p> : null}
        </form>
      </CardBody>
    </Card>
  );
}

function ConnectionSettings({ project, connectors, connections, onChanged }: { project: AgentProjectDto; connectors: ConnectorDto[]; connections: ConnectionDto[]; onChanged: () => Promise<void> }) {
  const requirements = project.agent.capability_resolution.requirements.filter(
    (requirement) => requirement.connector_id && connectors.find((connector) => connector.id === requirement.connector_id)?.auth_type !== "none",
  );
  return <Card><CardHeader title="Connections" description="PreviewとProductionで、利用する接続と許可する操作を分けます。" /><CardBody className="space-y-5">{(["staging", "production"] as Stage[]).map((stage) => <div key={stage}><h3 className="mb-3 text-sm font-semibold text-gray-900">{stage === "staging" ? "Preview" : "Production"}</h3><div className="space-y-3">{[...new Set(requirements.map((requirement) => requirement.connector_id!))].map((connectorId) => { const connector = connectors.find((item) => item.id === connectorId); if (!connector) return null; const linked = project.connection_links.find((link) => link.stage === stage && link.connector.id === connectorId); return <ConnectionLinkForm key={`${stage}-${connectorId}`} agentId={project.agent.id} stage={stage} connector={connector} connections={connections.filter((connection) => connection.connector_id === connectorId && connection.has_secret)} selected={linked?.connection.id ?? ""} allowed={[...new Set(requirements.filter((requirement) => requirement.connector_id === connectorId).flatMap((requirement) => requirement.tool_names))]} onChanged={onChanged} />; })}</div></div>)}</CardBody></Card>;
}

function ConnectionLinkForm({ agentId, stage, connector, connections, selected, allowed, onChanged }: { agentId: string; stage: Stage; connector: ConnectorDto; connections: { id: string; name: string }[]; selected: string; allowed: string[]; onChanged: () => Promise<void> }) {
  const [connectionId, setConnectionId] = useState(selected);
  const link = useActionMutation(linkAgentConnectionAction, { successMessage: `${connector.name}を${stage === "staging" ? "Preview" : "Production"}へ設定しました`, onSuccess: onChanged });
  return <form onSubmit={(event) => { event.preventDefault(); if (connectionId) void link.mutate(agentId, { stage, connector_id: connector.id, connection_id: connectionId, allowed_capabilities: allowed }); }} className="rounded-lg border border-gray-200 p-3"><div className="flex flex-col gap-3 sm:flex-row sm:items-end"><Field label={connector.name} hint={`${allowed.length}個の操作を許可`} className="flex-1"><Select value={connectionId} onChange={(event) => setConnectionId(event.target.value)}><option value="">Connectionを選択</option>{connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}</Select></Field><Button type="submit" size="sm" variant="secondary" disabled={!connectionId} loading={link.pending} icon={<Link2 className="h-4 w-4" />}>設定</Button></div>{connections.length === 0 ? <p className="mt-2 text-xs text-amber-700"><Link href="/integrations" className="font-medium underline">連携サービス</Link>でConnectionを作成してください。</p> : null}{link.error ? <p className="mt-2 text-xs text-red-600">{link.error.message}</p> : null}</form>;
}

function VariableSettings({ project, onChanged }: { project: AgentProjectDto; onChanged: () => Promise<void> }) {
  const required = project.agent.capability_resolution.missing_variables;
  return <Card><CardHeader title="Variables" description="環境ごとの設定値です。認証情報はここに入力せずConnectionsで管理します。" /><CardBody className="grid gap-5 lg:grid-cols-2">{(["staging", "production"] as Stage[]).map((stage) => <VariableForm key={stage} stage={stage} agentId={project.agent.id} names={required.length ? required : ["BENCHMARK_URL", "ACCOUNT_ID", "BRAND_TONE"]} initial={project.environments.find((environment) => environment.stage === stage)?.variables ?? {}} onChanged={onChanged} />)}</CardBody></Card>;
}

function VariableForm({ stage, agentId, names, initial, onChanged }: { stage: Stage; agentId: string; names: string[]; initial: Record<string, string>; onChanged: () => Promise<void> }) {
  const [values, setValues] = useState<Record<string, string>>(initial);
  const save = useActionMutation(setAgentEnvironmentAction, { successMessage: `${stage === "staging" ? "Preview" : "Production"} Variablesを保存しました`, onSuccess: onChanged });
  const submit = (event: FormEvent) => { event.preventDefault(); void save.mutate(agentId, { stage, variables: values }); };
  return <form onSubmit={submit} className="space-y-3 rounded-xl border border-gray-200 p-4"><h3 className="text-sm font-semibold text-gray-900">{stage === "staging" ? "Preview" : "Production"}</h3>{names.map((name) => <Field key={name} label={name}><Input value={values[name] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))} placeholder={name === "BENCHMARK_URL" ? "https://..." : ""} /></Field>)}<Button type="submit" size="sm" variant="secondary" loading={save.pending}>保存</Button>{save.error ? <p className="text-xs text-red-600">{save.error.message}</p> : null}</form>;
}
