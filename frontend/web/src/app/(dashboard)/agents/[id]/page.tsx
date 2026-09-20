"use client";

import type {
  AgentProjectDto,
  BrowserAccess,
  CapabilityRequirementDto,
  CapabilityVariableDto,
  ConnectionDto,
  ConnectorDto,
  DeploymentDto,
  Stage,
  ToolDto,
} from "@agent-studio/contracts";
import { isBrowserAccessConfigured, isBrowserCapability, usesBrowserCapability } from "@agent-studio/contracts";
import { CalendarClock, Check, CircleAlert, CloudUpload, ExternalLink, History, Link2, MessageSquare, Rocket, RotateCcw, Settings, Trash2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import {
  createPreviewAction,
  getAgentProjectAction,
  linkAgentConnectionAction,
  setAgentEnvironmentAction,
  setBrowserAccessAction,
} from "@/actions/agents";
import { listConnectionsAction } from "@/actions/connections";
import { listConnectorsAction, setConnectorOAuthAppAction } from "@/actions/connectors";
import { listDeploymentsAction, promoteDeploymentAction, rollbackDeploymentAction } from "@/actions/deployments";
import { createScheduleAction, deleteScheduleAction, listSchedulesAction, updateScheduleAction } from "@/actions/schedules";
import { AgentRun } from "@/components/agents/agent-run";
import { ErrorState } from "@/components/common/error-state";
import { PageHeader } from "@/components/common/page-header";
import { StageBadge, ToolRiskBadge } from "@/components/common/status-badges";
import { TimeAgo } from "@/components/common/time-ago";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { useActionQuery } from "@/hooks/use-action-query";
import { cn } from "@/lib/utils/cn";
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
  const connectionError = searchParams.get("connection_error");
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
        <Overview project={data} connectionError={connectionError} onChanged={project.reload} onGoTo={changeTab} />
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

function Overview({ project, connectionError, onChanged, onGoTo }: { project: AgentProjectDto; connectionError: string | null; onChanged: () => Promise<void>; onGoTo: (tab: ProjectTab) => void }) {
  const { organization, can } = useSession();
  const createPreview = useActionMutation(createPreviewAction, {
    successMessage: "Previewを作成しました",
    // 作ったらそのまま試せるところまで運ぶ
    onSuccess: async () => {
      await onChanged();
      onGoTo("preview");
    },
  });
  const connections = useActionQuery(() => listConnectionsAction(), [organization?.id]);
  const connectors = useActionQuery(() => listConnectorsAction(), [organization?.id]);
  const resolution = project.agent.capability_resolution;
  // 操作の識別子だけでは何をするか分からないので、連携サービスの定義から表示名と影響を引く
  const operations = new Map((connectors.data ?? []).flatMap((connector) => connector.tools.map((tool) => [tool.name, tool] as const)));
  // ブラウザを使うなら、接続してよい範囲を決めるまで動かせない（未設定はどこにも行けない）
  const usesBrowser = usesBrowserCapability(resolution);
  const browserReady = isBrowserAccessConfigured(project.agent.browser_access, project.agent.browser_allowed_domains);
  // 同じ連携サービスを使う作業は1つにまとめる。接続は連携サービス単位で1回設定すれば、その下の作業すべてに効く
  const groups = new Map<string, { connectorName: string; connectorKey: string | null; requirements: CapabilityRequirementDto[] }>();
  const standalone: CapabilityRequirementDto[] = [];
  for (const requirement of resolution.requirements) {
    if (!requirement.connector_id) {
      standalone.push(requirement);
      continue;
    }
    const connector = (connectors.data ?? []).find((candidate) => candidate.id === requirement.connector_id);
    const group = groups.get(requirement.connector_id) ?? {
      connectorName: requirement.connector_name ?? "連携サービス",
      connectorKey: connector?.key ?? null,
      requirements: [],
    };
    group.requirements.push(requirement);
    groups.set(requirement.connector_id, group);
  }
  return (
    <div className="grid gap-6 lg:grid-cols-[1.3fr_.7fr]">
      <Card>
        <CardHeader title="Agent Builder" description="必要な能力と接続を解決し、実行できるPreviewまで準備します。" />
        <CardBody className="space-y-3">
          {connectionError === "qiita_oauth_not_configured" ? (
            <Alert tone="warning">Qiitaを初めて使うため、運営者による1回限りの準備が必要です。下の案内から設定すると、自動で認証へ進みます。</Alert>
          ) : connectionError ? (
            <Alert tone="danger">Qiitaとの接続を完了できませんでした。もう一度認証してください。</Alert>
          ) : null}
          {resolution.requirements.map((requirement, index) => (
            <RequirementRow
              key={`${requirement.requirement}-${index}`}
              index={index + 1}
              requirement={requirement}
              operations={requirement.tool_names.map((name) => operations.get(name)).filter((tool): tool is ToolDto => Boolean(tool))}
            />
          ))}

          {[...groups.entries()]
            .filter(([connectorId]) => (connectors.data ?? []).find((c) => c.id === connectorId)?.auth_type !== "none")
            .map(([connectorId, group]) => (
            <ConnectorSetup
              key={connectorId}
              agentId={project.agent.id}
              connectorId={connectorId}
              connectorName={group.connectorName}
              connectorKey={group.connectorKey}
              oauthSetupRequired={connectionError === "qiita_oauth_not_configured" && group.connectorKey === "qiita"}
              canConfigureOAuthApp={can("organization.edit")}
              connected={group.requirements.every((requirement) => requirement.state === "resolved")}
              capabilities={[...new Set(group.requirements.flatMap((requirement) => requirement.tool_names))]}
              connections={(connections.data ?? []).filter(
                (connection) => connection.connector_id === connectorId && connection.has_secret,
              )}
              onChanged={async () => {
                await connections.reload();
                await onChanged();
              }}
            />
          ))}
          {usesBrowser ? (
            <BrowserAccessSetup
              agentId={project.agent.id}
              access={project.agent.browser_access}
              domains={project.agent.browser_allowed_domains}
              onChanged={onChanged}
            />
          ) : null}
          {resolution.requirements.length === 0 ? <Alert tone="info">外部連携なしで実行できるAgentです。</Alert> : null}

          {createPreview.error ? <Alert tone="danger">{createPreview.error.message}</Alert> : null}
          <div className="flex flex-wrap gap-2 pt-2">
            {resolution.ready && (!usesBrowser || browserReady) ? (
              <Button onClick={() => void createPreview.mutate(project.agent.id)} loading={createPreview.pending} icon={<CloudUpload className="h-4 w-4" />}>Previewを作成</Button>
            ) : (
              // 割り当てはこの画面で済ませられるので、詳細を見たい人だけ Settings へ
              <Button variant="secondary" onClick={() => onGoTo("settings")} icon={<Settings className="h-4 w-4" />}>設定を開く</Button>
            )}
          </div>
        </CardBody>
      </Card>
      <div className="space-y-6">
      {project.agent.project_brief ? (
        <Card>
          <CardHeader title="この Agent の元になった説明" description="入力した文章と、AIがそれをどう読み取ったかを並べています。" />
          <CardBody className="space-y-3 text-sm">
            <div>
              <p className="text-xs font-medium text-gray-500">あなたの入力</p>
              <p className="mt-1 whitespace-pre-wrap text-gray-900">{project.agent.project_brief}</p>
            </div>
            {project.agent.description ? (
              <div className="border-t border-gray-100 pt-3">
                <p className="text-xs font-medium text-gray-500">AIの読み取り</p>
                <p className="mt-1 whitespace-pre-wrap text-gray-700">{project.agent.description}</p>
                <p className="mt-2 text-xs text-gray-500">入力にない条件が足されていないか確認してください。違っていれば作り直せます。</p>
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}
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
    </div>
  );
}

/** 業務の流れの1ステップ。このステップで実際に何をするのかを見せる */
function RequirementRow({
  index,
  requirement,
  operations,
}: {
  index: number;
  requirement: CapabilityRequirementDto;
  operations: ToolDto[];
}) {
  const ready = requirement.state === "resolved";
  const label = ready ? "準備済み" : requirement.state === "needs_connection" ? "未接続" : "確認が必要";
  const browserRequirement = requirement.tool_names.some(isBrowserCapability);
  return (
    <div className="rounded-lg border border-gray-100 px-3 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-medium text-gray-600">{index}</span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-900">{requirement.requirement}</p>
            {operations.length === 0 ? <p className="mt-0.5 text-xs text-gray-500">{requirement.reason}</p> : null}
          </div>
        </div>
        <Badge tone={ready ? "success" : "warning"}>{label}</Badge>
      </div>
      {browserRequirement ? (
        <div className="mt-2.5 border-l-2 border-gray-100 pl-3 text-xs">
          <p className="font-medium text-gray-800">Browser Automation</p>
          <p className="mt-0.5 text-gray-500">公開Webページの閲覧と画面操作に使用します。内部の操作はAgent Studioが安全ルールに従って選びます。</p>
        </div>
      ) : operations.length > 0 ? (
        <ul className="mt-2.5 space-y-1.5 border-l-2 border-gray-100 pl-3">
          {operations.map((operation) => (
            <li key={operation.id} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-gray-500">{requirement.connector_name}の</span>
              <span className="font-medium text-gray-800">{operation.display_name}</span>
              <ToolRiskBadge risk={operation.risk} />
            </li>
          ))}
        </ul>
      ) : null}
      {requirement.variables.length > 0 ? (
        <ul className="mt-2.5 space-y-1.5 border-l-2 border-gray-100 pl-3">
          {requirement.variables.map((variable) => (
            <li key={variable.name} className="text-xs">
              <span className="font-medium text-gray-800">{variable.label}</span>
              <span className="ml-1.5 text-gray-400">{variable.required ? "必須" : "任意"}</span>
              {variable.description ? <p className="mt-0.5 text-gray-500">{variable.description}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {requirement.state === "missing" ? (
        <div className="mt-2.5 pl-3"><ButtonLink href="/integrations" size="sm" variant="secondary">連携サービスを追加</ButtonLink></div>
      ) : null}
    </div>
  );
}

/**
 * ブラウザで接続してよい範囲。業務の設定値ではなく安全の境界なので、ここで別に決める。
 * 決めるまで Preview を作れない（未設定のままだとどこにも接続できない）。
 */
function BrowserAccessSetup({
  agentId,
  access,
  domains,
  onChanged,
}: {
  agentId: string;
  access: BrowserAccess;
  domains: string[];
  onChanged: () => Promise<void>;
}) {
  const configured = isBrowserAccessConfigured(access, domains);
  const [choice, setChoice] = useState<BrowserAccess>(access);
  const [text, setText] = useState(domains.join("\n"));
  const save = useActionMutation(setBrowserAccessAction, { successMessage: "接続範囲を保存し、稼働中の環境に反映しました", onSuccess: onChanged });

  const submit = () =>
    save.mutate(agentId, {
      access: choice,
      allowed_domains: choice === "public" ? [] : text.split("\n").map((line) => line.trim()).filter(Boolean),
    });

  return (
    <div className={cn("rounded-lg border px-3 py-3", configured ? "border-gray-100" : "border-amber-200 bg-amber-50/60")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-gray-900">ブラウザで接続できる範囲</p>
          <p className="mt-0.5 text-xs text-gray-600">
            {configured ? "保存するとPreviewと公開済みのProductionに反映され、次回実行から使われます。Production公開後の変更には管理者権限が必要です。" : "このAgentはWebページを開きます。どこまで接続してよいかを決めてください。"}
          </p>
        </div>
        {configured ? <Badge tone="success">設定済み</Badge> : <Badge tone="warning">未設定</Badge>}
      </div>

      <div className="mt-2.5 space-y-2">
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" className="mt-1" checked={choice === "public"} onChange={() => setChoice("public")} />
          <span>
            <span className="font-medium text-gray-900">公開Webサイト全般</span>
            <span className="mt-0.5 block text-xs text-gray-500">実行のたびに違うURLを渡す使い方はこちらです。</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" className="mt-1" checked={choice === "restricted"} onChange={() => setChoice("restricted")} />
          <span>
            <span className="font-medium text-gray-900">指定したサイトだけ</span>
            <span className="mt-0.5 block text-xs text-gray-500">決まった相手とだけやり取りする業務はこちらです。</span>
          </span>
        </label>
        {choice === "restricted" ? (
          <Textarea
            rows={3}
            className="text-xs"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={"1行に1つ入力します\nexample.com\ndocs.example.jp"}
          />
        ) : null}
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" loading={save.pending} onClick={() => void submit()}>
            保存
          </Button>
          {save.error ? <p className="text-xs text-red-600">{save.error.message}</p> : null}
        </div>
      </div>
    </div>
  );
}

/** 連携サービス1つぶんの接続。上で「使う」にした作業だけを許可して、PreviewとProductionへまとめて設定する */
function ConnectorSetup({
  agentId,
  connectorId,
  connectorName,
  connectorKey,
  oauthSetupRequired,
  canConfigureOAuthApp,
  connected,
  capabilities,
  connections,
  onChanged,
}: {
  agentId: string;
  connectorId: string;
  connectorName: string;
  connectorKey: string | null;
  oauthSetupRequired: boolean;
  canConfigureOAuthApp: boolean;
  connected: boolean;
  capabilities: string[];
  connections: ConnectionDto[];
  onChanged: () => Promise<void>;
}) {
  const [selected, setSelected] = useState("");
  const link = useActionMutation(linkAgentConnectionAction, { successMessage: `${connectorName}を設定しました`, onSuccess: onChanged });
  const connectionId = connections.length === 1 ? connections[0]!.id : selected;

  const apply = async () => {
    if (!connectionId) return;
    for (const stage of ["staging", "production"] as Stage[]) {
      await link.mutate(agentId, { stage, connector_id: connectorId, connection_id: connectionId, allowed_capabilities: capabilities });
    }
  };

  if (connections.length === 0) {
    if (connectorKey === "qiita" && oauthSetupRequired) {
      return (
        <QiitaOAuthAppSetup
          agentId={agentId}
          connectorId={connectorId}
          canConfigure={canConfigureOAuthApp}
        />
      );
    }
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-3">
        <p className="text-sm font-medium text-gray-900">{connectorName}に接続してください</p>
        <p className="mt-0.5 text-xs text-gray-600">{connectorName}の認証情報がまだ登録されていません。</p>
        <ButtonLink
          href={connectorKey === "qiita" ? `/integrations/qiita/oauth/start?connector=${encodeURIComponent(connectorId)}&agent=${encodeURIComponent(agentId)}` : "/integrations"}
          size="sm"
          variant="secondary"
          className="mt-2.5"
        >
          {connectorKey === "qiita" ? "Qiitaで認証して続ける" : "連携サービスを開く"}
        </ButtonLink>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-indigo-100 bg-indigo-50/50 px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-gray-900">{connectorName}の接続</p>
          <p className="mt-0.5 text-xs text-gray-600">
            {connected
              ? `設定済みです。${capabilities.length}個の操作を許可しています。`
              : `1回の設定で、上のすべての作業に反映されます。${capabilities.length}個の操作を許可します。`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {connections.length > 1 ? (
            <Select className="w-48" value={selected} onChange={(event) => setSelected(event.target.value)}>
              <option value="">接続を選ぶ</option>
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>{connection.name}</option>
              ))}
            </Select>
          ) : (
            <span className="text-xs text-gray-600">{connections[0]!.name}</span>
          )}
          <Button size="sm" loading={link.pending} disabled={!connectionId} onClick={() => void apply()} icon={<Link2 className="h-4 w-4" />}>
            {connected ? "更新" : "接続"}
          </Button>
        </div>
      </div>
      {link.error ? <p className="mt-2 text-xs text-red-600">{link.error.message}</p> : null}
    </div>
  );
}

/** Provider側でOAuth applicationが未登録でも、Agent Builderから離れず準備して認証を再開する。 */
function QiitaOAuthAppSetup({ agentId, connectorId, canConfigure }: { agentId: string; connectorId: string; canConfigure: boolean }) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("/integrations/qiita/oauth/callback");
  useEffect(() => setCallbackUrl(`${window.location.origin}/integrations/qiita/oauth/callback`), []);
  const save = useActionMutation(setConnectorOAuthAppAction, {
    successMessage: "Qiita OAuthアプリを安全に保存しました。認証へ進みます",
    onSuccess: () => {
      window.location.assign(
        `/integrations/qiita/oauth/start?connector=${encodeURIComponent(connectorId)}&agent=${encodeURIComponent(agentId)}`,
      );
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!clientId.trim() || !clientSecret) return;
    void save.mutate(connectorId, { client_id: clientId.trim(), client_secret: clientSecret });
  };

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50/70 px-4 py-4">
      <p className="text-sm font-semibold text-gray-900">Qiitaを利用可能にする（初回のみ）</p>
      <p className="mt-1 text-xs leading-relaxed text-gray-600">
        この準備はAgentごとではなく、この組織で最初の1回だけです。完了後、他の利用者は「Qiitaで認証」を押すだけになります。
      </p>
      {!canConfigure ? (
        <Alert className="mt-3" tone="warning">組織のownerにこの初回設定を依頼しました。設定が終わると、ここから続行できます。</Alert>
      ) : (
        <form className="mt-3 space-y-3" onSubmit={submit}>
          <ol className="list-decimal space-y-1 pl-5 text-xs leading-relaxed text-gray-700">
            <li>
              <a className="font-medium text-accent-700 underline" href="https://qiita.com/settings/applications" target="_blank" rel="noreferrer">
                QiitaでOAuthアプリを登録 <ExternalLink className="inline h-3 w-3" aria-hidden="true" />
              </a>
            </li>
            <li>リダイレクト先URLに次を指定します。</li>
          </ol>
          <code className="block break-all rounded-md border border-amber-200 bg-white px-2.5 py-2 text-xs text-gray-800">{callbackUrl}</code>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Client ID" required error={save.fieldErrors.client_id}>
              <Input value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" />
            </Field>
            <Field label="Client Secret" required hint="保存後は表示されません" error={save.fieldErrors.client_secret}>
              <Input type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} autoComplete="new-password" />
            </Field>
          </div>
          {save.error ? <Alert tone="danger">{save.error.message}</Alert> : null}
          <Button type="submit" size="sm" loading={save.pending} disabled={!clientId.trim() || !clientSecret}>
            安全に保存してQiita認証へ進む
          </Button>
        </form>
      )}
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-4 border-b border-gray-100 pb-3 last:border-0"><span className="text-gray-500">{label}</span><span className="text-right font-medium text-gray-900">{value}</span></div>;
}

function Preview({ project }: { project: AgentProjectDto }) {
  const { organization } = useSession();
  const deployments = useActionQuery(() => listDeploymentsAction({ agent_id: project.agent.id }), [project.agent.id, organization?.id, project.deployments.map((deployment) => `${deployment.id}:${deployment.status}`).join(",")]);
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
  const seen = new Set<string>();
  const variables = project.agent.capability_resolution.requirements
    .flatMap((requirement) => requirement.variables)
    .filter((variable) => (seen.has(variable.name) ? false : seen.add(variable.name)));
  if (variables.length === 0) return null;
  return <Card><CardHeader title="設定値" description="PreviewとProductionで別々に持てます。パスワードやAPIキーはここではなくConnectionsで管理します。" /><CardBody className="grid gap-5 lg:grid-cols-2">{(["staging", "production"] as Stage[]).map((stage) => <VariableForm key={stage} stage={stage} agentId={project.agent.id} variables={variables} initial={project.environments.find((environment) => environment.stage === stage)?.variables ?? {}} onChanged={onChanged} />)}</CardBody></Card>;
}

function VariableForm({ stage, agentId, variables, initial, onChanged }: { stage: Stage; agentId: string; variables: CapabilityVariableDto[]; initial: Record<string, string>; onChanged: () => Promise<void> }) {
  const [values, setValues] = useState<Record<string, string>>(initial);
  const save = useActionMutation(setAgentEnvironmentAction, { successMessage: `${stage === "staging" ? "Preview" : "Production"}の設定値を保存しました`, onSuccess: onChanged });
  const submit = (event: FormEvent) => { event.preventDefault(); void save.mutate(agentId, { stage, variables: values }); };
  return <form onSubmit={submit} className="space-y-3 rounded-xl border border-gray-200 p-4"><h3 className="text-sm font-semibold text-gray-900">{stage === "staging" ? "Preview" : "Production"}</h3>{variables.map((variable) => <Field key={variable.name} label={`${variable.label}${variable.required ? "" : "（任意）"}`} hint={variable.description || undefined}><Input value={values[variable.name] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [variable.name]: event.target.value }))} placeholder={variable.example ?? ""} /></Field>)}<Button type="submit" size="sm" variant="secondary" loading={save.pending}>保存</Button>{save.error ? <p className="text-xs text-red-600">{save.error.message}</p> : null}</form>;
}
