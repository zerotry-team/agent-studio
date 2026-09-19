"use client";

import type { BootstrapTokenDto, RuntimeDto, RuntimeStatus } from "@agent-studio/contracts";
import { Ban, KeyRound, RefreshCw, Wrench } from "lucide-react";
import { useState } from "react";
import {
  getRuntimeAction,
  issueBootstrapTokenAction,
  revokeRuntimeAction,
  rotateEnvironmentKeyAction,
} from "@/actions/runtimes";
import { PageHeader } from "@/components/common/page-header";
import { QueryView } from "@/components/common/query-view";
import { RuntimeStatusBadge, StageBadge, ToolRiskBadge } from "@/components/common/status-badges";
import { TimeAgo } from "@/components/common/time-ago";
import { BootstrapTokenDialog } from "@/components/environments/bootstrap-token-dialog";
import { runtimeSecretsLocation } from "@/components/environments/runtime-secrets";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DescriptionList } from "@/components/ui/description-list";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton, SkeletonGroup, SkeletonText, TableSkeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";
import { formatDateTime } from "@/lib/utils/format";
import { PROVISIONING_TYPE_LABELS, RUNTIME_STATUS_DESCRIPTIONS } from "@/lib/utils/labels";

const BACK = { href: "/environments", label: "実行環境の一覧" };

const STATUS_ALERT_TONE: Record<RuntimeStatus, "info" | "success" | "warning" | "danger"> = {
  pending: "info",
  active: "success",
  degraded: "warning",
  offline: "danger",
  revoked: "warning",
};

/** 準備中は登録を待つので短い間隔で、それ以外はゆっくり状態を取り直す（失効後は取り直さない） */
function pollInterval(runtime: RuntimeDto | undefined): number | false {
  if (!runtime) return false;
  if (runtime.status === "pending") return 5_000;
  if (runtime.status === "revoked") return false;
  return 30_000;
}

function RuntimeSkeleton() {
  return (
    <SkeletonGroup>
      <Skeleton className="mb-6 h-14 w-full rounded-xl" />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm lg:col-span-2">
          <Skeleton className="h-5 w-32" />
          <SkeletonText className="mt-5" lines={4} />
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <Skeleton className="h-5 w-24" />
          <SkeletonText className="mt-5" lines={3} />
        </div>
      </div>
      <div className="mt-6 rounded-xl border border-gray-200 bg-white shadow-sm">
        <TableSkeleton rows={3} columns={4} />
      </div>
    </SkeletonGroup>
  );
}

export default function RuntimeDetailPage({ params }: { params: { id: string } }) {
  const { organization } = useSession();
  const query = useActionQuery(() => getRuntimeAction(params.id), [organization?.id, params.id], {
    refetchInterval: pollInterval,
  });

  return (
    <>
      {query.data === undefined ? <PageHeader title="Runtime の詳細" back={BACK} /> : null}
      <QueryView query={query} loading={<RuntimeSkeleton />}>
        {(runtime) => <RuntimeDetail runtime={runtime} onUpdated={(next) => query.setData(next)} />}
      </QueryView>
    </>
  );
}

type ConfirmKind = "rotate" | "revoke" | null;

function RuntimeDetail({ runtime, onUpdated }: { runtime: RuntimeDto; onUpdated: (runtime: RuntimeDto) => void }) {
  const { can } = useSession();
  const canManage = can("environment.manage");
  const canRevoke = can("runtime.revoke");
  const revoked = runtime.status === "revoked";
  const pending = runtime.status === "pending";
  const [token, setToken] = useState<BootstrapTokenDto | null>(null);
  const [confirm, setConfirm] = useState<ConfirmKind>(null);

  const issue = useActionMutation(issueBootstrapTokenAction);
  const rotate = useActionMutation(rotateEnvironmentKeyAction, { successMessage: "環境キーの入れ替えを開始しました" });
  const revoke = useActionMutation(revokeRuntimeAction, { successMessage: "Runtime を失効させました" });

  const issueToken = async () => {
    const res = await issue.mutate(runtime.id);
    if (res.ok) setToken(res.data);
  };

  const location = runtimeSecretsLocation(runtime);

  const actions = revoked ? null : (
    <>
      {canManage ? (
        <Button
          variant={pending ? "primary" : "secondary"}
          onClick={issueToken}
          loading={issue.pending}
          icon={<KeyRound className="h-4 w-4" aria-hidden="true" />}
        >
          登録用トークンを発行
        </Button>
      ) : null}
      {canManage && !pending ? (
        <Button variant="secondary" onClick={() => setConfirm("rotate")} icon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}>
          環境キーを入れ替える
        </Button>
      ) : null}
      {canRevoke ? (
        <Button variant="danger-outline" onClick={() => setConfirm("revoke")} icon={<Ban className="h-4 w-4" aria-hidden="true" />}>
          失効させる
        </Button>
      ) : null}
    </>
  );

  return (
    <>
      <PageHeader
        back={BACK}
        title={runtime.name}
        meta={
          <>
            <RuntimeStatusBadge status={runtime.status} />
            <StageBadge stage={runtime.stage} />
          </>
        }
        description={PROVISIONING_TYPE_LABELS[runtime.provisioning_type]}
        actions={actions}
      />

      <Alert tone={STATUS_ALERT_TONE[runtime.status]} className="mb-6" title={RUNTIME_STATUS_DESCRIPTIONS[runtime.status]}>
        {pending && !canManage ? (
          <p>登録用トークンの発行は、管理者以上の権限を持つメンバーが行います。この画面は自動で更新されます。</p>
        ) : pending ? (
          <ol className="mt-1 list-decimal space-y-0.5 pl-5">
            <li>「登録用トークンを発行」を押して、トークンを受け取ります。</li>
            <li>表示されたコマンドで、御社の AWS の Secrets Manager にトークンを設定します。</li>
            <li>Runtime Controller が起動すると自動で登録され、状態が「接続済み」に変わります（この画面は自動で更新されます）。</li>
          </ol>
        ) : runtime.status === "offline" || runtime.status === "degraded" ? (
          <p>
            最終応答: <TimeAgo value={runtime.last_heartbeat_at} fallback="なし" />
          </p>
        ) : null}
      </Alert>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="詳細" />
          <CardBody>
            <DescriptionList
              columns={2}
              items={[
                {
                  label: "最終応答",
                  value: runtime.last_heartbeat_at ? (
                    <span>
                      <TimeAgo value={runtime.last_heartbeat_at} />
                      <span className="ml-1 text-xs text-gray-500">（{formatDateTime(runtime.last_heartbeat_at)}）</span>
                    </span>
                  ) : (
                    "なし"
                  ),
                },
                {
                  label: "コントローラーのバージョン",
                  value: runtime.controller_version ? <span className="font-mono text-[13px]">{runtime.controller_version}</span> : "—",
                },
                { label: "登録日時", value: runtime.registered_at ? formatDateTime(runtime.registered_at) : "まだ登録されていません" },
                { label: "作成", value: formatDateTime(runtime.created_at) },
                { label: "AWS アカウント ID", value: <span className="font-mono text-[13px]">{runtime.aws_account_id}</span> },
                { label: "リージョン", value: <span className="font-mono text-[13px]">{runtime.aws_region}</span> },
                {
                  label: "IAM ロール名",
                  value: <span className="break-all font-mono text-[13px]">{runtime.expected_role_name}</span>,
                  wide: true,
                },
              ]}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="シークレットの保存先" />
          <CardBody className="space-y-3 text-sm leading-relaxed text-gray-600">
            <p>この Runtime の認証情報は、御社の AWS の Secrets Manager の次の場所に保管されます。</p>
            <code className="block break-all rounded-lg bg-gray-50 px-3 py-2 font-mono text-[13px] text-gray-900">{location.prefix}/</code>
            {location.tenant ? null : (
              <p className="text-xs text-gray-500">
                IAM ロール名からテナントの短い名前を読み取れなかったため、&lt;tenant&gt; の部分は config.yaml の short_name に置き換えてください。
              </p>
            )}
          </CardBody>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader
          title="Runtime が報告しているツール"
          description="Runtime の Tool Gateway に登録されているツールです。Agent Studio 側にも同じ名前で登録されたツールだけが使えます。"
        />
        {runtime.tools.length === 0 ? (
          <EmptyState
            icon={Wrench}
            title="まだツールの報告はありません"
            description="登録が終わると表示されます。Runtime の設定ファイル（config.yaml の runtime.tools）に書いたツールが、ここに表示されます。"
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>ツール名</TH>
                <TH className="hidden md:table-cell">説明</TH>
                <TH>リスク</TH>
                <TH>信頼できない内容を読むか</TH>
              </tr>
            </THead>
            <TBody>
              {runtime.tools.map((tool) => (
                <TR key={tool.name}>
                  <TD className="max-w-[14rem]">
                    <code className="block truncate font-mono text-[13px] text-gray-900">{tool.name}</code>
                    <span className="line-clamp-2 text-xs text-gray-500 md:hidden">{tool.description}</span>
                  </TD>
                  <TD className="hidden max-w-md md:table-cell">
                    <span className="line-clamp-2 text-gray-600">{tool.description}</span>
                  </TD>
                  <TD>
                    <ToolRiskBadge risk={tool.risk} />
                  </TD>
                  <TD className="text-gray-700">{tool.reads_untrusted_content ? "はい" : "いいえ"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {token ? <BootstrapTokenDialog runtime={runtime} token={token} onClose={() => setToken(null)} /> : null}

      <ConfirmDialog
        open={confirm === "rotate"}
        onClose={() => setConfirm(null)}
        tone="primary"
        title="環境キーを入れ替えますか？"
        description="OpenAI の環境キーを新しいものに入れ替えます。実行中のセッションに影響が出ることがあります。"
        confirmLabel="入れ替える"
        onConfirm={async () => {
          const res = await rotate.mutate(runtime.id);
          if (!res.ok) return false;
        }}
      />

      <ConfirmDialog
        open={confirm === "revoke"}
        onClose={() => setConfirm(null)}
        tone="danger"
        title={`Runtime「${runtime.name}」を失効させますか？`}
        description="この操作は取り消せません。以後この Runtime はトークンを取得できず、未処理のジョブは取り消されます。実行中のセッションも中止されます。"
        confirmLabel="失効させる"
        confirmText={runtime.name}
        onConfirm={async () => {
          const res = await revoke.mutate(runtime.id);
          if (!res.ok) return false;
          onUpdated(res.data);
        }}
      />
    </>
  );
}
