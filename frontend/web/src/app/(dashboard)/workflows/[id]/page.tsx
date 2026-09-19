"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { getWorkflowAction } from "@/actions/workflows";
import { ErrorState } from "@/components/common/error-state";
import { PageHeader } from "@/components/common/page-header";
import { Badge } from "@/components/ui/badge";
import { CardSkeleton, Skeleton } from "@/components/ui/skeleton";
import { TabPanel, tabPanelId, Tabs } from "@/components/ui/tabs";
import { WorkflowDefinitionForm } from "@/components/workflows/workflow-definition-form";
import { WorkflowRunsPanel } from "@/components/workflows/workflow-runs-panel";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";

type Tab = "definition" | "runs";
const BACK = { href: "/workflows", label: "ワークフロー" };

function WorkflowDetailSkeleton() {
  return (
    <>
      <div className="mb-6 space-y-3" aria-hidden="true">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-7 w-64 max-w-full" />
        <Skeleton className="h-4 w-32" />
      </div>
      <div className="space-y-4">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    </>
  );
}

export default function WorkflowDetailPage({ params }: { params: { id: string } }) {
  const { can, organization } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => (searchParams.get("tab") === "runs" ? "runs" : "definition"));
  const query = useActionQuery(() => getWorkflowAction(params.id), [organization?.id, params.id]);

  const changeTab = (next: Tab) => {
    setTab(next);
    const qs = new URLSearchParams(searchParams.toString());
    if (next === "runs") qs.set("tab", "runs");
    else qs.delete("tab");
    const s = qs.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };

  const workflow = query.data;
  if (!workflow) {
    if (query.error) {
      return (
        <>
          <PageHeader title="ワークフロー" back={BACK} />
          <ErrorState message={query.error.message} onRetry={query.reload} retrying={query.refreshing} />
        </>
      );
    }
    return <WorkflowDetailSkeleton />;
  }

  return (
    <>
      <PageHeader
        back={BACK}
        title={workflow.name}
        meta={<Badge tone="accent">バージョン {workflow.version}</Badge>}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              キー: <span className="font-mono text-gray-700">{workflow.key}</span>
            </span>
            <span>ステップ {workflow.definition.steps.length}個</span>
          </span>
        }
      />

      <Tabs
        label="ワークフローの表示切り替え"
        idPrefix="workflow"
        value={tab}
        onChange={changeTab}
        tabs={[
          { id: "definition", label: "定義" },
          { id: "runs", label: "実行" },
        ]}
      />

      {/* 編集中の内容を失わないように、定義タブは切り替えても消さずに隠す */}
      <div
        role="tabpanel"
        id={tabPanelId("workflow", "definition")}
        aria-labelledby="workflow-tab-definition"
        tabIndex={0}
        hidden={tab !== "definition"}
        className="pt-6 focus:outline-none"
      >
        <WorkflowDefinitionForm
          key={workflow.version}
          workflow={workflow}
          editable={can("workflow.edit")}
          onSaved={(saved) => query.setData(saved)}
        />
      </div>

      <TabPanel id="runs" value={tab} idPrefix="workflow">
        <WorkflowRunsPanel workflow={workflow} />
      </TabPanel>
    </>
  );
}
