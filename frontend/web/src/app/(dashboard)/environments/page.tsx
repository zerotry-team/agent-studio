"use client";

import { Plus } from "lucide-react";
import { listRuntimeProfilesAction } from "@/actions/environments";
import { listRuntimesAction } from "@/actions/runtimes";
import { PageHeader } from "@/components/common/page-header";
import { RuntimeProfilesCard } from "@/components/environments/runtime-profiles-card";
import { RuntimesCard } from "@/components/environments/runtimes-card";
import { ButtonLink } from "@/components/ui/button";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";

/** 準備中の Runtime があるときは短い間隔で、それ以外はゆっくり状態を取り直す */
const PENDING_POLL_MS = 10_000;
const IDLE_POLL_MS = 60_000;

export default function EnvironmentsPage() {
  const { organization, can } = useSession();
  const canManage = can("environment.manage");
  const profiles = useActionQuery(() => listRuntimeProfilesAction(), [organization?.id]);
  const runtimes = useActionQuery(() => listRuntimesAction(), [organization?.id], {
    refetchInterval: (data) => (data?.some((r) => r.status === "pending") ? PENDING_POLL_MS : IDLE_POLL_MS),
  });

  const createButton = canManage ? (
    <ButtonLink href="/environments/new" variant="primary" icon={<Plus className="h-4 w-4" aria-hidden="true" />}>
      新しい実行環境
    </ButtonLink>
  ) : null;

  return (
    <>
      <PageHeader
        title="実行環境"
        description="エージェントを動かす場所を管理します。OpenAI の環境のほか、自社の AWS アカウントや Agent Studio が用意する AWS でも実行できます。"
        actions={createButton}
      />
      <div className="space-y-6">
        <RuntimeProfilesCard query={profiles} runtimes={runtimes.data} canManage={canManage} createAction={createButton} />
        <RuntimesCard query={runtimes} canManage={canManage} createAction={createButton} />
      </div>
    </>
  );
}
