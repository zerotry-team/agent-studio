"use client";

import type { ConnectionDto, ConnectorDto } from "@agent-studio/contracts";
import { Check, ChevronDown, ChevronUp, Link2, Pencil, Plus, RefreshCw, ShieldCheck, ShieldOff } from "lucide-react";
import { useState } from "react";
import { listConnectionsAction, revokeConnectionAction, validateConnectionAction } from "@/actions/connections";
import { createConnectorAction, listConnectorsAction } from "@/actions/connectors";
import { listRuntimesAction } from "@/actions/runtimes";
import { PageHeader } from "@/components/common/page-header";
import { ToolRiskBadge } from "@/components/common/status-badges";
import { CreateConnectionDialog } from "@/components/connections/create-connection-dialog";
import { CreateConnectorDialog } from "@/components/connectors/create-connector-dialog";
import { SetConnectionSecretDialog } from "@/components/connections/set-connection-secret-dialog";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";

const SOCIAL_ROUTER_PRESET = {
  key: "social-router",
  name: "Social Router",
  description: "接続したSNSアカウントの投稿取得と、承認済み投稿の公開に利用します。",
  adapter: "http_openapi" as const,
  base_url: "https://d3vatrn3wuw8oq.cloudfront.net",
  auth_type: "static_bearer" as const,
  operations: [
    {
      name: "list_accounts",
      display_name: "アカウントを確認",
      description: "接続済みSNSアカウントと利用可能な操作を取得する",
      method: "GET" as const,
      path: "/v1/accounts",
      risk: "read" as const,
      input_schema: { type: "object" as const, properties: {}, additionalProperties: false },
    },
    {
      name: "list_posts",
      display_name: "過去投稿を取得",
      description: "指定した自社SNSアカウントの過去投稿を取得する",
      method: "GET" as const,
      path: "/v1/posts",
      risk: "read" as const,
      input_schema: {
        type: "object" as const,
        properties: { account_id: { type: "string" }, limit: { type: "number" }, cursor: { type: "string" } },
        required: ["account_id"],
        additionalProperties: false,
      },
    },
    {
      name: "get_post",
      display_name: "投稿詳細を取得",
      description: "自社SNS投稿の詳細と反応情報を取得する",
      method: "GET" as const,
      path: "/v1/posts/{id}",
      risk: "read" as const,
      input_schema: { type: "object" as const, properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    },
    {
      name: "publish_post",
      display_name: "SNSへ公開投稿",
      description: "明示承認された本文を指定アカウントへ非同期で投稿する",
      method: "POST" as const,
      path: "/v1/posts",
      idempotency_key_field: "logical_post_id",
      risk: "external_send" as const,
      input_schema: {
        type: "object" as const,
        properties: {
          account_id: { type: "string" },
          text: { type: "string" },
          media_ids: { type: "array", items: { type: "string" } },
          logical_post_id: { type: "string" },
        },
        required: ["account_id", "text", "logical_post_id"],
        additionalProperties: false,
      },
    },
    {
      name: "get_job",
      display_name: "投稿結果を確認",
      description: "非同期投稿Jobの状態を確認し、succeededの場合だけ成功と判断する",
      method: "GET" as const,
      path: "/v1/jobs/{id}",
      risk: "read" as const,
      input_schema: { type: "object" as const, properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    },
  ],
};

const BROWSER_PRESET = {
  key: "browser-automation",
  name: "ブラウザ操作",
  description: "公開Webページを開き、表示内容を安全に読み取って調査や比較に利用します。",
  adapter: "runtime" as const,
  auth_type: "none" as const,
  operations: [
    {
      name: "browser_navigate",
      display_name: "Webページを開く",
      description: "指定した公開URLをBrowserで開く",
      risk: "read" as const,
      input_schema: {
        type: "object" as const,
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_snapshot",
      display_name: "ページ内容を読み取る",
      description: "開いているWebページの表示内容と参照可能な要素を取得する",
      risk: "read" as const,
      input_schema: { type: "object" as const, properties: {}, additionalProperties: false },
    },
    {
      name: "browser_screenshot",
      display_name: "画面を確認",
      description: "現在のブラウザ画面を元の解像度で取得する",
      risk: "read" as const,
      input_schema: { type: "object" as const, properties: { full_page: { type: "boolean" } }, additionalProperties: false },
    },
    {
      name: "browser_wait_for",
      display_name: "表示を待つ",
      description: "ページ内の文字や要素が表示されるまで待つ",
      risk: "read" as const,
      input_schema: { type: "object" as const, properties: { text: { type: "string" }, selector: { type: "string" }, timeout_ms: { type: "number" } }, additionalProperties: false },
    },
    ...([
      ["browser_tabs", "タブを操作", "タブを一覧・選択・閉じる"],
      ["browser_click", "画面をクリック", "画面上の要素をクリックする"],
      ["browser_type", "文字を入力", "入力欄へ文字列を入力する"],
      ["browser_press_key", "キーを入力", "現在の画面へキー入力する"],
      ["browser_select_option", "選択肢を変更", "選択項目の値を変更する"],
      ["browser_hover", "要素を確認", "要素へマウスを重ねる"],
      ["browser_drag", "要素を移動", "要素間をドラッグする"],
      ["browser_exec_js", "複数画面を調査", "公開ページを制限付きPlaywrightコードで操作する"],
    ] as const).map(([name, display_name, description]) => ({
      name,
      display_name,
      description,
      risk: "write" as const,
      input_schema: { type: "object" as const, properties: {}, additionalProperties: true },
    })),
    {
      name: "browser_download",
      display_name: "ファイルを取得",
      description: "DownloadをRun専用Artifactとして安全検査し、本文をモデルへ渡さず保持する",
      risk: "read" as const,
      input_schema: { type: "object" as const, properties: { selector: { type: "string" }, text: { type: "string" } }, additionalProperties: false },
    },
    {
      name: "browser_upload",
      display_name: "Artifactを送信",
      description: "このRunで取得したArtifact IDだけを承認後に許可済みWeb画面へUploadする",
      risk: "external_send" as const,
      input_schema: {
        type: "object" as const,
        properties: {
          selector: { type: "string" }, artifact_id: { type: "string" }, destination: { type: "string" },
          filename: { type: "string" }, sha256: { type: "string" },
        },
        required: ["selector", "artifact_id", "destination", "filename", "sha256"],
        additionalProperties: false,
      },
    },
  ],
};

type DialogState = { kind: "connection"; connector: ConnectorDto } | { kind: "secret"; connection: ConnectionDto } | null;

export default function IntegrationsPage() {
  const { organization, can } = useSession();
  const connectors = useActionQuery(() => listConnectorsAction(), [organization?.id]);
  const connections = useActionQuery(() => listConnectionsAction(), [organization?.id]);
  const runtimes = useActionQuery(() => listRuntimesAction(), [organization?.id]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [connectorDialogOpen, setConnectorDialogOpen] = useState(false);
  const [editingConnector, setEditingConnector] = useState<ConnectorDto | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ConnectionDto | null>(null);
  const validateConnection = useActionMutation(validateConnectionAction, {
    successMessage: (connection) => connection.status === "connected" ? "Connectionを確認しました" : "Connectionに問題が見つかりました",
    onSuccess: () => connections.reload(),
  });
  const revokeConnection = useActionMutation(revokeConnectionAction, {
    successMessage: "Connectionを失効しました",
    onSuccess: () => connections.reload(),
  });
  const addSocialRouter = useActionMutation(createConnectorAction, {
    successMessage: "Social Routerを追加しました",
    onSuccess: () => connectors.reload(),
  });
  const addBrowser = useActionMutation(createConnectorAction, {
    successMessage: "Browserを有効にしました",
    onSuccess: () => connectors.reload(),
  });
  const socialRouterExists = connectors.data?.some((connector) => connector.key === "social-router");
  const browserExists = connectors.data?.some((connector) => connector.key === "browser-automation" || connector.key === "browser");

  return (
    <>
      <PageHeader
        title="連携サービス"
        description="Agentが業務で使うサービスを接続します。認証情報は組織で一度だけ設定し、Agentごと・環境ごとに利用を許可します。"
        actions={can("tool.edit") ? <div className="flex flex-wrap gap-2">
          {!browserExists ? <Button variant="secondary" onClick={() => void addBrowser.mutate(BROWSER_PRESET)} loading={addBrowser.pending}>ブラウザ操作を有効化</Button> : null}
          {!socialRouterExists ? <Button variant="secondary" onClick={() => void addSocialRouter.mutate(SOCIAL_ROUTER_PRESET)} loading={addSocialRouter.pending}>Social Routerを追加</Button> : null}
          <Button onClick={() => setConnectorDialogOpen(true)} icon={<Plus className="h-4 w-4" aria-hidden="true" />}>連携サービスを登録</Button>
        </div> : null}
      />

      {addSocialRouter.error ? <Alert tone="danger">{addSocialRouter.error.message}</Alert> : null}
      {addBrowser.error ? <Alert tone="danger">{addBrowser.error.message}</Alert> : null}

      {!connectors.data ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1].map((item) => <Skeleton key={item} className="h-52 rounded-xl" />)}
        </div>
      ) : connectors.data.length === 0 ? (
        <Card>
          <EmptyState
            icon={Link2}
            title="連携サービスはまだありません"
            description="サービスを登録すると、Agent作成時に必要な能力として選べるようになります。"
          />
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {connectors.data.map((connector) => {
            const installations = (connections.data ?? []).filter((connection) => connection.connector_id === connector.id);
            const connectionFree = connector.auth_type === "none";
            const open = expanded === connector.id;
            return (
              <Card key={connector.id}>
                <CardHeader
                  title={connector.name}
                  description={connector.description}
                  actions={connectionFree || installations.some((connection) => connection.has_secret && connection.status === "connected") ? <Badge tone="success" dot>利用可能</Badge> : <Badge tone="warning" dot>未接続</Badge>}
                />
                <CardBody className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2 text-sm text-gray-600">
                    <ShieldCheck className="h-4 w-4 text-gray-400" aria-hidden="true" />
                    {connector.tools.length}個の操作を権限別に管理
                  </div>
                  {installations.map((connection) => (
                    <div key={connection.id} className="space-y-2 rounded-lg bg-gray-50 px-3 py-2.5 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium text-gray-800">{connection.name}</span>
                        <Badge tone={connection.status === "connected" && connection.has_secret ? "success" : connection.status === "error" ? "danger" : "warning"}>
                          {connection.status === "revoked" ? "失効済み" : connection.status === "expired" ? "期限切れ" : connection.status === "error" ? "接続エラー" : connection.has_secret ? "利用可能" : "認証情報が必要"}
                        </Badge>
                      </div>
                      {connection.expires_at ? <p className="text-xs text-gray-500">有効期限: {new Date(connection.expires_at).toLocaleString("ja-JP")}</p> : null}
                      {can("connection.manage") ? (
                        <div className="flex flex-wrap gap-1.5">
                          <Button variant="ghost" size="sm" onClick={() => setDialog({ kind: "secret", connection })}>
                            {connection.has_secret ? "認証情報を更新" : "認証情報を設定"}
                          </Button>
                          {connection.has_secret && connection.status !== "revoked" ? (
                            <Button variant="ghost" size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={validateConnection.pending} onClick={() => void validateConnection.mutate(connection.id)}>
                              接続を確認
                            </Button>
                          ) : null}
                          {connection.status !== "revoked" ? (
                            <Button variant="ghost" size="sm" icon={<ShieldOff className="h-3.5 w-3.5" />} onClick={() => setRevokeTarget(connection)}>
                              失効
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ))}
                  <div className="flex flex-wrap gap-2">
                    {can("connection.manage") && !connectionFree ? (
                      <Button variant="secondary" size="sm" onClick={() => setDialog({ kind: "connection", connector })}>
                        {installations.length > 0 ? "別のConnectionを追加" : `${connector.name}を接続`}
                      </Button>
                    ) : null}
                    <Button variant="ghost" size="sm" onClick={() => setExpanded(open ? null : connector.id)} icon={open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}>
                      許可できる操作
                    </Button>
                    {can("tool.edit") && (connector.adapter === "http_openapi" || connector.adapter === "mcp") ? (
                      <Button variant="ghost" size="sm" onClick={() => setEditingConnector(connector)} icon={<Pencil className="h-4 w-4" aria-hidden="true" />}>
                        編集
                      </Button>
                    ) : null}
                  </div>
                  {open ? (
                    <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
                      {connector.tools.map((tool) => (
                        <div key={tool.id} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                          <span className="flex items-center gap-2 font-medium text-gray-800"><Check className="h-4 w-4 text-emerald-600" />{tool.display_name}</span>
                          <ToolRiskBadge risk={tool.risk} />
                        </div>
                      ))}
                    </div>
                  ) : null}
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}

      <div className="mt-6 text-sm text-gray-500">
        詳細な接続方式や個別操作を管理する場合は <ButtonLink href="/tools" variant="ghost" size="sm">Advanced</ButtonLink> を利用できます。
      </div>

      {connectorDialogOpen || editingConnector ? (
        <CreateConnectorDialog
          connector={editingConnector ?? undefined}
          onClose={() => {
            setConnectorDialogOpen(false);
            setEditingConnector(null);
          }}
          onCreated={() => {
            setConnectorDialogOpen(false);
            setEditingConnector(null);
            void connectors.reload();
          }}
        />
      ) : null}

      {dialog?.kind === "connection" ? (
        <CreateConnectionDialog
          connector={dialog.connector}
          runtimes={runtimes.data}
          runtimesFailed={Boolean(runtimes.error)}
          onClose={() => setDialog(null)}
          onCreated={(connection) => {
            void connections.reload();
            setDialog({ kind: "secret", connection });
          }}
        />
      ) : null}
      {dialog?.kind === "secret" ? (
        <SetConnectionSecretDialog
          connection={dialog.connection}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void connections.reload();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={Boolean(revokeTarget)}
        onClose={() => setRevokeTarget(null)}
        onConfirm={async () => revokeTarget ? (await revokeConnection.mutate(revokeTarget.id)).ok : false}
        title="Connectionを失効しますか"
        description="このConnectionを使うPreviewとProductionは、認証情報を再設定するまで外部サービスを利用できません。"
        confirmLabel="失効する"
      />
    </>
  );
}
