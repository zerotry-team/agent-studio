"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { getAgentAction } from "@/actions/agents";
import { listDeploymentsAction } from "@/actions/deployments";
import { AgentDefinition } from "@/components/agents/agent-definition";
import { AgentDeploy } from "@/components/agents/agent-deploy";
import { AgentEval } from "@/components/agents/agent-eval";
import { AgentOverview } from "@/components/agents/agent-overview";
import { AgentRun } from "@/components/agents/agent-run";
import { activeDeployments, AGENT_TABS, type AgentTab } from "@/components/agents/deployment-select";
import { useMemberNames } from "@/components/agents/use-member-names";
import { ErrorState } from "@/components/common/error-state";
import { PageHeader } from "@/components/common/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton, SkeletonGroup, SkeletonText } from "@/components/ui/skeleton";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";

const TAB_LABELS: Record<AgentTab, string> = {
  overview: "概要",
  definition: "定義",
  deploy: "デプロイ",
  run: "実行",
  eval: "テスト",
};

function parseTab(value: string | null): AgentTab {
  return AGENT_TABS.find((t) => t === value) ?? "overview";
}

function BackLink() {
  return (
    <Link
      href="/agents"
      className="mb-4 inline-flex items-center gap-1.5 rounded text-sm text-gray-500 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      エージェント一覧
    </Link>
  );
}

function DetailSkeleton() {
  return (
    <SkeletonGroup>
      <Skeleton className="h-7 w-64" />
      <Skeleton className="mt-3 h-4 w-40" />
      <Skeleton className="mt-2 h-4 w-full max-w-xl" />
      <div className="mt-8 flex gap-4 border-b border-gray-200 pb-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-4 w-14" />
        ))}
      </div>
      <div className="mt-6 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <Skeleton className="h-5 w-1/3" />
        <SkeletonText className="mt-4" lines={4} />
      </div>
    </SkeletonGroup>
  );
}

export default function AgentDetailPage({ params }: { params: { id: string } }) {
  const { organization } = useSession();
  const searchParams = useSearchParams();
  const urlTab = parseTab(searchParams.get("tab"));
  const [tab, setTab] = useState<AgentTab>(urlTab);

  // URL の ?tab= が（リンクや戻る操作で）変わったときに合わせる
  useEffect(() => {
    setTab(urlTab);
  }, [urlTab]);

  const changeTab = useCallback((next: AgentTab) => {
    setTab(next);
    const query = new URLSearchParams(window.location.search);
    if (next === "overview") query.delete("tab");
    else query.set("tab", next);
    const qs = query.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }, []);

  const agentQuery = useActionQuery(() => getAgentAction(params.id), [params.id, organization?.id]);
  const deploymentsQuery = useActionQuery(() => listDeploymentsAction({ agent_id: params.id }), [params.id, organization?.id]);
  const memberName = useMemberNames();

  const agent = agentQuery.data;

  if (!agent) {
    return (
      <>
        <BackLink />
        {agentQuery.error ? (
          <ErrorState
            message={agentQuery.error.message}
            onRetry={agentQuery.error.code === "not_found" ? undefined : agentQuery.reload}
            retrying={agentQuery.refreshing}
          />
        ) : (
          <DetailSkeleton />
        )}
      </>
    );
  }

  const activeCount = activeDeployments(deploymentsQuery.data).length;

  return (
    <>
      <PageHeader
        title={agent.name}
        back={{ href: "/agents", label: "エージェント一覧" }}
        meta={
          agent.published_version !== null ? (
            <Badge tone="success">v{agent.published_version} を公開中</Badge>
          ) : (
            <Badge tone="neutral">未公開</Badge>
          )
        }
        description={
          <>
            <span className="inline-block rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-700">{agent.key}</span>
            {agent.description ? <p className="mt-2 whitespace-pre-wrap">{agent.description}</p> : null}
          </>
        }
      />

      {agentQuery.error ? (
        <Alert tone="warning" className="mb-4" title="最新の情報を読み込めませんでした">
          {agentQuery.error.message}
        </Alert>
      ) : null}

      <Tabs
        label="エージェントの情報の切り替え"
        idPrefix="agent"
        value={tab}
        onChange={changeTab}
        tabs={AGENT_TABS.map((id) => ({
          id,
          label: TAB_LABELS[id],
          badge: id === "deploy" && activeCount > 0 ? activeCount : undefined,
        }))}
      />

      <TabPanel id="overview" value={tab} idPrefix="agent">
        <AgentOverview agent={agent} onChanged={agentQuery.reload} memberName={memberName} />
      </TabPanel>
      <TabPanel id="definition" value={tab} idPrefix="agent">
        <AgentDefinition agent={agent} onSaved={agentQuery.reload} />
      </TabPanel>
      <TabPanel id="deploy" value={tab} idPrefix="agent">
        <AgentDeploy agent={agent} deployments={deploymentsQuery} memberName={memberName} onGoToTab={changeTab} />
      </TabPanel>
      <TabPanel id="run" value={tab} idPrefix="agent">
        <AgentRun deployments={deploymentsQuery} onGoToTab={changeTab} />
      </TabPanel>
      <TabPanel id="eval" value={tab} idPrefix="agent">
        <AgentEval agent={agent} deployments={deploymentsQuery} onGoToTab={changeTab} />
      </TabPanel>
    </>
  );
}
