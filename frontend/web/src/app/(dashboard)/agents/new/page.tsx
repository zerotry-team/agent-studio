"use client";

import { AgentCreator } from "@/components/agents/agent-creator";
import { Forbidden } from "@/components/common/forbidden";
import { PageHeader } from "@/components/common/page-header";
import { useSession } from "@/hooks/use-session";

export default function NewAgentPage() {
  const { can } = useSession();
  const allowed = can("agent.edit");

  return (
    <>
      <PageHeader
        title="Agentを作成"
        description={
          allowed
            ? "業務を説明すると、必要な連携と安全ルールを解決し、PreviewできるAgent Projectを作ります。"
            : undefined
        }
        back={{ href: "/agents", label: "エージェント一覧" }}
      />
      {allowed ? (
        <AgentCreator />
      ) : (
        <Forbidden
          title="エージェントを作る権限がありません"
          description="エージェントの作成は、作成者以上の権限を持つメンバーが行えます。必要な場合は組織の管理者に問い合わせてください。"
        />
      )}
    </>
  );
}
