"use client";

import type { ConnectionDto, RuntimeDto } from "@agent-studio/contracts";
import { KeyRound, Plug, Plus, Settings2, Terminal, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { deleteConnectionAction, listConnectionsAction } from "@/actions/connections";
import { listRuntimesAction } from "@/actions/runtimes";
import { PageHeader } from "@/components/common/page-header";
import { QueryView } from "@/components/common/query-view";
import { TimeAgo } from "@/components/common/time-ago";
import { CreateConnectionDialog } from "@/components/connections/create-connection-dialog";
import { RuntimeSecretHelpDialog } from "@/components/connections/runtime-secret-help-dialog";
import { SetConnectionSecretDialog } from "@/components/connections/set-connection-secret-dialog";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { TableSkeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";
import { CONNECTION_SCOPE_LABELS } from "@/lib/utils/labels";

type DialogState =
  | { kind: "create" }
  | { kind: "secret"; connection: ConnectionDto }
  | { kind: "runtime-help"; connection: ConnectionDto }
  | { kind: "delete"; connection: ConnectionDto }
  | null;

export default function ConnectionsPage() {
  const { organization, can } = useSession();
  const canManage = can("connection.manage");
  const query = useActionQuery(() => listConnectionsAction(), [organization?.id]);
  const runtimes = useActionQuery(() => listRuntimesAction(), [organization?.id]);
  const [dialog, setDialog] = useState<DialogState>(null);
  const remove = useActionMutation(deleteConnectionAction, {
    successMessage: "接続先を削除しました",
  });

  const runtimeOf = (connection: ConnectionDto): RuntimeDto | undefined =>
    connection.runtime_id ? runtimes.data?.find((r) => r.id === connection.runtime_id) : undefined;

  const createButton = canManage ? (
    <div className="flex flex-wrap gap-2">
      <ButtonLink href="/settings?tab=infrastructure" variant="secondary" icon={<Settings2 className="h-4 w-4" aria-hidden="true" />}>
        実行・開発基盤
      </ButtonLink>
      <Button icon={<Plus className="h-4 w-4" aria-hidden="true" />} onClick={() => setDialog({ kind: "create" })}>
        接続先を登録
      </Button>
    </div>
  ) : null;

  return (
    <>
      <PageHeader
        title="接続先"
        description="社内システムや外部サービスに接続するための認証情報の保管場所です。認証情報の値は Agent Studio のデータベースには保存されず、保存後に画面で見ることもできません。"
        actions={createButton}
      />

      <QueryView
        query={query}
        loading={
          <Card>
            <TableSkeleton rows={4} columns={5} />
          </Card>
        }
        isEmpty={(items) => items.length === 0}
        empty={
          <Card>
            <EmptyState
              icon={Plug}
              title="接続先はまだ登録されていません"
              description={
                canManage
                  ? "ツールが社内システムや外部サービスに接続するときに使う認証情報を、ここで管理します。"
                  : "接続先が登録されると、ここに表示されます。接続先の登録は管理者が行います。"
              }
              action={createButton}
            />
          </Card>
        }
      >
        {(connections) => (
          <Card>
            <Table>
              <THead>
                <tr>
                  <TH>名前</TH>
                  <TH className="hidden sm:table-cell">保管場所</TH>
                  <TH className="hidden md:table-cell">詳細</TH>
                  <TH>認証情報</TH>
                  <TH className="hidden lg:table-cell">作成</TH>
                  <TH className="text-right">
                    <span className="sr-only">操作</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {connections.map((connection) => (
                  <ConnectionRow
                    key={connection.id}
                    connection={connection}
                    runtime={runtimeOf(connection)}
                    runtimesLoading={runtimes.loading}
                    canManage={canManage}
                    onSetSecret={() => setDialog({ kind: "secret", connection })}
                    onRuntimeHelp={() => setDialog({ kind: "runtime-help", connection })}
                    onDelete={() => setDialog({ kind: "delete", connection })}
                  />
                ))}
              </TBody>
            </Table>
          </Card>
        )}
      </QueryView>

      {dialog?.kind === "create" ? (
        <CreateConnectionDialog
          runtimes={runtimes.data}
          runtimesFailed={!!runtimes.error}
          onClose={() => setDialog(null)}
          onCreated={(connection) => {
            void query.reload();
            // 続けて認証情報を設定できるようにする
            setDialog(connection.scope === "runtime" ? { kind: "runtime-help", connection } : { kind: "secret", connection });
          }}
        />
      ) : null}

      {dialog?.kind === "secret" ? (
        <SetConnectionSecretDialog
          connection={dialog.connection}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void query.reload();
          }}
        />
      ) : null}

      {dialog?.kind === "runtime-help" ? (
        <RuntimeSecretHelpDialog connection={dialog.connection} runtime={runtimeOf(dialog.connection)} onClose={() => setDialog(null)} />
      ) : null}

      <ConfirmDialog
        open={dialog?.kind === "delete"}
        onClose={() => setDialog(null)}
        title={dialog?.kind === "delete" ? `接続先「${dialog.connection.name}」を削除しますか？` : "接続先を削除しますか？"}
        description="この接続先を使うように設定しているツールは、認証が必要な呼び出しに失敗するようになります。元に戻すことはできません。"
        confirmLabel="削除する"
        onConfirm={async () => {
          if (dialog?.kind !== "delete") return;
          const res = await remove.mutate(dialog.connection.id);
          if (!res.ok) return false;
          const removedId = dialog.connection.id;
          query.setData((prev) => prev?.filter((c) => c.id !== removedId));
        }}
      />
    </>
  );
}

function ConnectionRow({
  connection,
  runtime,
  runtimesLoading,
  canManage,
  onSetSecret,
  onRuntimeHelp,
  onDelete,
}: {
  connection: ConnectionDto;
  runtime: RuntimeDto | undefined;
  runtimesLoading: boolean;
  canManage: boolean;
  onSetSecret: () => void;
  onRuntimeHelp: () => void;
  onDelete: () => void;
}) {
  const isRuntime = connection.scope === "runtime";
  const isGitHubApp = connection.metadata.provider === "github_app";

  return (
    <TR>
      <TD className="max-w-[16rem]">
        <span className="block truncate font-medium text-gray-900">{connection.name}</span>
        {connection.description ? <span className="block truncate text-xs text-gray-500">{connection.description}</span> : null}
        <span className="block text-xs text-gray-500 sm:hidden">{CONNECTION_SCOPE_LABELS[connection.scope]}</span>
      </TD>
      <TD className="hidden text-gray-600 sm:table-cell">{CONNECTION_SCOPE_LABELS[connection.scope]}</TD>
      <TD className="hidden max-w-[16rem] md:table-cell">
        <ConnectionDetails connection={connection} runtime={runtime} runtimesLoading={runtimesLoading} />
      </TD>
      <TD>
        {isRuntime ? (
          <Badge tone="neutral">自社の AWS で管理</Badge>
        ) : connection.has_secret ? (
          <Badge tone="success" dot>
            設定済み
          </Badge>
        ) : (
          <Badge tone="warning" dot>
            未設定
          </Badge>
        )}
      </TD>
      <TD className="hidden text-gray-500 lg:table-cell">
        <TimeAgo value={connection.created_at} />
      </TD>
      <TD>
        <div className="flex items-center justify-end gap-1">
          {isRuntime ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={onRuntimeHelp}
              aria-label={`登録方法（${connection.name}）`}
              icon={<Terminal className="h-4 w-4" aria-hidden="true" />}
            >
              <span className="hidden sm:inline">登録方法</span>
            </Button>
          ) : canManage && !isGitHubApp ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={onSetSecret}
              aria-label={`認証情報を設定（${connection.name}）`}
              icon={<KeyRound className="h-4 w-4" aria-hidden="true" />}
            >
              <span className="hidden sm:inline">認証情報を設定</span>
            </Button>
          ) : null}
          {canManage ? (
            <Button variant="ghost" size="icon-sm" onClick={onDelete} aria-label={`接続先「${connection.name}」を削除`} title="削除">
              <Trash2 className="h-4 w-4 text-gray-500" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </TD>
    </TR>
  );
}

function ConnectionDetails({
  connection,
  runtime,
  runtimesLoading,
}: {
  connection: ConnectionDto;
  runtime: RuntimeDto | undefined;
  runtimesLoading: boolean;
}) {
  if (connection.scope === "studio") {
    if (connection.metadata.provider === "github_app") {
      return (
        <span className="block min-w-0 text-xs text-gray-600">
          <span className="block truncate font-medium text-gray-800">
            {String(connection.metadata.owner)}/{String(connection.metadata.repository)}
          </span>
          <span className="block truncate">base: {String(connection.metadata.base_branch)}</span>
        </span>
      );
    }
    return (
      <span className="text-xs text-gray-600">
        ヘッダ: <code className="font-mono text-gray-800">{connection.header_name ?? "Authorization"}</code>
      </span>
    );
  }
  if (connection.scope === "runtime") {
    return (
      <span className="block min-w-0 text-xs text-gray-600">
        <span className="block truncate">
          {runtime ? (
            <Link href={`/runtimes/${runtime.id}`} className="font-medium text-gray-800 hover:text-accent-700 hover:underline">
              {runtime.name}
            </Link>
          ) : runtimesLoading ? (
            "読み込み中…"
          ) : (
            "Runtime が見つかりません"
          )}
        </span>
        <code className="block truncate font-mono text-gray-800">{connection.runtime_secret_name}</code>
      </span>
    );
  }
  return <span className="text-xs text-gray-400">—</span>;
}
