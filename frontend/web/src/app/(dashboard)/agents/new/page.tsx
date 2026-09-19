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
        title="エージェントを作る"
        description={
          allowed
            ? "任せたい仕事を説明すると、AI がエージェントの定義の案を作ります。内容を確認・編集してから保存してください。"
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
