"use client";

import type { ConnectionDto, RuntimeDto } from "@agent-studio/contracts";
import { GitBranch, Server, Settings2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { listConnectionsAction } from "@/actions/connections";
import { listRuntimesAction } from "@/actions/runtimes";
import { CreateGitHubAppConnectionDialog } from "@/components/connections/create-github-app-connection-dialog";
import { RuntimeStatusBadge, StageBadge } from "@/components/common/status-badges";
import { TimeAgo } from "@/components/common/time-ago";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { SkeletonText } from "@/components/ui/skeleton";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";

const isGitHubApp = (connection: ConnectionDto) => connection.metadata.provider === "github_app";
const isRuntimeReady = (runtime: RuntimeDto) => ["active", "degraded"].includes(runtime.status);

/** 組織で一度だけ準備する、Agent共通の実行・Adapter配布基盤。 */
export function InfrastructureTab() {
  const { organization, can } = useSession();
  const searchParams = useSearchParams();
  const connections = useActionQuery(() => listConnectionsAction(), [organization?.id]);
  const runtimes = useActionQuery(() => listRuntimesAction(), [organization?.id], { refetchInterval: 30_000 });
  const [githubDialog, setGitHubDialog] = useState(() => searchParams.get("connect") === "github");
  const githubApps = (connections.data ?? []).filter(isGitHubApp);
  const readyRuntimes = (runtimes.data ?? []).filter(isRuntimeReady);

  return (
    <div className="space-y-6">
      <Alert tone="info" title="Agentより先に、組織の基盤として設定します">
        Self-host Runtimeは社内データとToolの実行場所、GitHub Appは不足Adapterを専用branch・PRで配布する経路です。
        Agent Builderはここで準備済みの基盤を参照し、Agentごとに秘密情報を聞きません。
      </Alert>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader
            title={<span className="flex items-center gap-2"><Server className="h-5 w-5 text-accent-600" aria-hidden="true" />Self-host Runtime</span>}
            description="組織内のデータ、Browser、生成Workspaceを自社環境で動かします。Heartbeatで状態とTool Catalogを自動更新します。"
            actions={<Badge tone={readyRuntimes.length ? "success" : "warning"} dot>{readyRuntimes.length ? `${readyRuntimes.length}台 稼働中` : "準備が必要"}</Badge>}
          />
          <CardBody className="space-y-4">
            {runtimes.loading && !runtimes.data ? <SkeletonText lines={3} /> : null}
            {runtimes.error ? <Alert tone="danger">Runtimeの状態を取得できませんでした。</Alert> : null}
            {runtimes.data?.length ? (
              <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
                {runtimes.data.map((runtime) => <RuntimeRow key={runtime.id} runtime={runtime} />)}
              </div>
            ) : !runtimes.loading ? (
              <p className="rounded-lg bg-gray-50 px-4 py-5 text-sm leading-6 text-gray-600">
                Runtimeはまだありません。OpenAI環境だけで完結しないAgentを作る前に、管理者が登録します。
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {can("environment.manage") ? <ButtonLink href="/environments/new">Self-host Runtimeを追加</ButtonLink> : null}
              <ButtonLink href="/environments" variant="secondary">実行環境を管理</ButtonLink>
            </div>
          </CardBody>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader
            title={<span className="flex items-center gap-2"><GitBranch className="h-5 w-5 text-accent-600" aria-hidden="true" />GitHub App</span>}
            description="新しいAdapterコードが必要な場合だけ、許可したRepositoryへ専用branchをpushし、PR・CI・mergeを追跡します。"
            actions={<Badge tone={githubApps.some((connection) => connection.status === "connected") ? "success" : "neutral"} dot>{githubApps.some((connection) => connection.status === "connected") ? "接続済み" : "未設定・任意"}</Badge>}
          />
          <CardBody className="space-y-4">
            {connections.loading && !connections.data ? <SkeletonText lines={3} /> : null}
            {connections.error ? <Alert tone="danger">GitHub Appの状態を取得できませんでした。</Alert> : null}
            {githubApps.length ? (
              <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
                {githubApps.map((connection) => <GitHubAppRow key={connection.id} connection={connection} />)}
              </div>
            ) : !connections.loading ? (
              <p className="rounded-lg bg-gray-50 px-4 py-5 text-sm leading-6 text-gray-600">
                既存のToolだけでAgentを作る場合は設定不要です。Builderが新しいAdapterを実装するときに接続します。
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {can("connection.manage") ? (
                <Button onClick={() => setGitHubDialog(true)} icon={<GitBranch className="h-4 w-4" aria-hidden="true" />}>GitHub Appを接続</Button>
              ) : null}
              <ButtonLink href="/connections" variant="secondary" icon={<Settings2 className="h-4 w-4" aria-hidden="true" />}>接続先の詳細</ButtonLink>
            </div>
          </CardBody>
        </Card>
      </div>

      {githubDialog ? (
        <CreateGitHubAppConnectionDialog
          onClose={() => setGitHubDialog(false)}
          onCreated={() => {
            setGitHubDialog(false);
            void connections.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function RuntimeRow({ runtime }: { runtime: RuntimeDto }) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <Link href={`/runtimes/${runtime.id}`} className="block truncate text-sm font-medium text-gray-900 hover:text-accent-700 hover:underline">
          {runtime.name}
        </Link>
        <p className="mt-1 text-xs text-gray-500">Tool {runtime.tools.length}件・最終応答 <TimeAgo value={runtime.last_heartbeat_at} fallback="なし" /></p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <StageBadge stage={runtime.stage} />
        <RuntimeStatusBadge status={runtime.status} />
      </div>
    </div>
  );
}

function GitHubAppRow({ connection }: { connection: ConnectionDto }) {
  const owner = typeof connection.metadata.owner === "string" ? connection.metadata.owner : "—";
  const repository = typeof connection.metadata.repository === "string" ? connection.metadata.repository : "—";
  const branch = typeof connection.metadata.base_branch === "string" ? connection.metadata.base_branch : "—";
  return (
    <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-gray-900">{owner}/{repository}</p>
        <p className="mt-1 text-xs text-gray-500">{connection.name}・base branch: {branch}</p>
      </div>
      <Badge tone={connection.status === "connected" ? "success" : connection.status === "revoked" ? "neutral" : "warning"} dot>
        {connection.status === "connected" ? "利用可能" : connection.status === "expired" ? "期限切れ" : connection.status === "revoked" ? "失効" : "要確認"}
      </Badge>
    </div>
  );
}
