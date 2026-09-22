"use client";

import type { ConnectionDto, ConnectorDto, ProviderCatalogEntryDto } from "@agent-studio/contracts";
import { Check, ChevronDown, ChevronUp, Link2, Plus, RefreshCw, ShieldCheck, ShieldOff } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { createConnectionAction, listConnectionsAction, revokeConnectionAction, validateConnectionAction } from "@/actions/connections";
import { ensureCatalogConnectorAction, listConnectorsAction, listProviderCatalogAction } from "@/actions/connectors";
import { PageHeader } from "@/components/common/page-header";
import { ToolRiskBadge } from "@/components/common/status-badges";
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

type ConnectorState = "ready" | "needs_auth" | "waiting_admin";

/**
 * 連携サービスは「状態を見る」画面。識別子・URL・操作一覧の入力はここには無い。
 * 有名サービスはカタログから1クリックで用意し、認証（OAuth / APIキー）だけを人が行う。
 * 手動での連携登録や個別操作の管理は 設定 > 詳細設定 にある。
 */
export default function IntegrationsPage() {
  const { organization, can } = useSession();
  const searchParams = useSearchParams();
  const connectors = useActionQuery(() => listConnectorsAction(), [organization?.id]);
  const connections = useActionQuery(() => listConnectionsAction(), [organization?.id]);
  const catalog = useActionQuery(() => listProviderCatalogAction(), [organization?.id]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [secretTarget, setSecretTarget] = useState<ConnectionDto | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ConnectionDto | null>(null);
  const connectionError = searchParams.get("connection_error");
  const connected = searchParams.get("connection") === "connected";

  const validateConnection = useActionMutation(validateConnectionAction, {
    successMessage: (connection) => connection.status === "connected" ? "接続を確認しました" : "接続に問題が見つかりました",
    onSuccess: () => connections.reload(),
  });
  const revokeConnection = useActionMutation(revokeConnectionAction, { successMessage: "接続を停止しました", onSuccess: () => connections.reload() });
  const addFromCatalog = useActionMutation(ensureCatalogConnectorAction, {
    successMessage: (connector) => `${connector.name}を追加しました。次に接続を行います`,
    onSuccess: async () => {
      await connectors.reload();
      await catalog.reload();
    },
  });
  const prepareConnection = useActionMutation(createConnectionAction, { errorToast: true });

  const catalogByKey = new Map((catalog.data ?? []).map((entry) => [entry.key, entry]));
  const stateOf = (connector: ConnectorDto, installations: ConnectionDto[]): ConnectorState => {
    const entry = connector.provider_key ? catalogByKey.get(connector.provider_key) : undefined;
    if (entry?.requires_self_hosted || connector.adapter === "runtime") return "waiting_admin";
    if (connector.auth_type === "none") return "ready";
    return installations.some((connection) => connection.has_secret && connection.status === "connected") ? "ready" : "needs_auth";
  };

  /** OAuth なら同意画面へ、API キーならその場で入力欄を開く（Connection 枠は自動で用意） */
  const connect = async (connector: ConnectorDto, installations: ConnectionDto[]) => {
    const entry = connector.provider_key ? catalogByKey.get(connector.provider_key) : undefined;
    if (entry?.auth_kind === "oauth2") {
      window.location.assign(`/integrations/oauth/start?connector=${encodeURIComponent(connector.id)}`);
      return;
    }
    const existing = installations.find((connection) => connection.status !== "revoked");
    if (existing) {
      setSecretTarget(existing);
      return;
    }
    const created = await prepareConnection.mutate({
      name: `${connector.name}（Preview用）`,
      connector_id: connector.id,
      scope: connector.adapter === "mcp" ? "openai_vault" : "studio",
      header_name: connector.adapter === "mcp" ? undefined : "Authorization",
    });
    if (created.ok) {
      await connections.reload();
      setSecretTarget(created.data);
    }
  };

  const available = (catalog.data ?? []).filter((entry) => !entry.connector_id && entry.auth_kind !== "github_app");

  return (
    <>
      <PageHeader
        title="連携サービス"
        description="Agentが業務で使うサービスの接続状態です。必要なサービスはAgent作成時にBuilderが自動で用意し、認証だけをお願いします。"
        actions={can("connection.manage") ? <ButtonLink href="/settings?tab=advanced" variant="ghost" size="sm">詳細設定（管理者向け）</ButtonLink> : null}
      />

      {connected ? <Alert tone="success">接続が完了しました。</Alert> : null}
      {connectionError === "oauth_not_configured" ? <Alert tone="warning">このサービスのOAuthアプリがまだ登録されていません。運営者（オーナー）がAgentの作成画面から一度だけ登録できます。</Alert> : null}
      {connectionError === "oauth_failed" || connectionError === "oauth_state" ? <Alert tone="danger">接続を完了できませんでした。もう一度お試しください。</Alert> : null}
      {addFromCatalog.error ? <Alert tone="danger">{addFromCatalog.error.message}</Alert> : null}

      {!connectors.data ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1].map((item) => <Skeleton key={item} className="h-40 rounded-xl" />)}
        </div>
      ) : connectors.data.length === 0 ? (
        <Card>
          <EmptyState
            icon={Link2}
            title="連携サービスはまだありません"
            description="Agentを作るときに必要なサービスをBuilderが自動で用意します。先に用意したい場合は下の一覧から追加できます。"
          />
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {connectors.data.map((connector) => {
            const installations = (connections.data ?? []).filter((connection) => connection.connector_id === connector.id);
            const state = stateOf(connector, installations);
            const open = expanded === connector.id;
            const active = installations.find((connection) => connection.status === "connected" && connection.has_secret);
            return (
              <Card key={connector.id}>
                <CardHeader
                  title={connector.name}
                  description={connector.description}
                  actions={
                    state === "ready" ? <Badge tone="success" dot>接続済み</Badge>
                      : state === "waiting_admin" ? <Badge tone="neutral" dot>管理者の準備待ち</Badge>
                        : <Badge tone="warning" dot>接続が必要です</Badge>
                  }
                />
                <CardBody className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2 text-sm text-gray-600">
                    <ShieldCheck className="h-4 w-4 text-gray-400" aria-hidden="true" />
                    {state === "ready" && connector.auth_type !== "none" && active
                      ? `${active.name} で ${connector.tools.length}個の操作を許可`
                      : state === "waiting_admin"
                        ? "貴社専用の実行環境で動きます（AWS管理者が準備します）"
                        : `${connector.tools.length}個の操作を必要なときだけ許可します`}
                  </div>
                  {installations.filter((connection) =>
                    // Builder が用意しただけで未入力の枠は「エラー」ではないので出さない
                    (connection.status === "expired" || connection.status === "error") && !(connection.metadata.managed_by === "builder" && !connection.has_secret),
                  ).map((connection) => (
                    <p key={connection.id} className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                      {connection.name}: {connection.status === "expired" ? "有効期限が切れています。もう一度接続してください" : "認証情報を確認できませんでした"}
                    </p>
                  ))}
                  <div className="flex flex-wrap gap-2">
                    {state === "needs_auth" && can("connection.manage") ? (
                      <Button size="sm" loading={prepareConnection.pending} onClick={() => void connect(connector, installations)} icon={<Link2 className="h-4 w-4" aria-hidden="true" />}>
                        接続して続ける
                      </Button>
                    ) : null}
                    {state === "ready" && active && can("connection.manage") ? (
                      <>
                        <Button variant="ghost" size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={validateConnection.pending} onClick={() => void validateConnection.mutate(active.id)}>
                          接続を確認
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setSecretTarget(active)}>認証情報を更新</Button>
                        <Button variant="ghost" size="sm" icon={<ShieldOff className="h-3.5 w-3.5" />} onClick={() => setRevokeTarget(active)}>接続を停止</Button>
                      </>
                    ) : null}
                    <Button variant="ghost" size="sm" onClick={() => setExpanded(open ? null : connector.id)} icon={open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}>
                      許可できる操作
                    </Button>
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

      {can("tool.edit") && available.length ? (
        <Card className="mt-6">
          <CardHeader title="追加できるサービス" description="Agent作成時に依頼文から自動で追加されます。先に用意したい場合はここから追加できます（設定項目はありません）。" />
          <CardBody>
            <div className="flex flex-wrap gap-2">
              {available.map((entry: ProviderCatalogEntryDto) => (
                <Button key={entry.key} variant="secondary" size="sm" loading={addFromCatalog.pending} onClick={() => void addFromCatalog.mutate(entry.key)} icon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}>
                  {entry.name}
                </Button>
              ))}
            </div>
          </CardBody>
        </Card>
      ) : null}

      {secretTarget ? (
        <SetConnectionSecretDialog
          connection={secretTarget}
          onClose={() => setSecretTarget(null)}
          onSaved={async () => {
            const target = secretTarget;
            setSecretTarget(null);
            await validateConnection.mutate(target.id);
            await connections.reload();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={Boolean(revokeTarget)}
        onClose={() => setRevokeTarget(null)}
        onConfirm={async () => revokeTarget ? (await revokeConnection.mutate(revokeTarget.id)).ok : false}
        title="接続を停止しますか"
        description="この接続を使うPreviewとProductionは、もう一度接続するまで外部サービスを利用できません。"
        confirmLabel="停止する"
      />
    </>
  );
}
