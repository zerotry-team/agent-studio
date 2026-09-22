"use client";

import type { HumanActionDto } from "@agent-studio/contracts";
import { ExternalLink, KeyRound, Link2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { setConnectionSecretAction, validateConnectionAction } from "@/actions/connections";
import { setConnectorOAuthAppAction } from "@/actions/connectors";
import { Alert } from "@/components/ui/alert";
import { Button, ButtonLink } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { useSession } from "@/hooks/use-session";

/**
 * 認証だけをその場で済ませるカード。連携サービス画面へは遷移しない。
 * - OAuth: 「接続する」で Provider の同意画面へ。OAuth アプリ未登録なら運営者がここで一度だけ登録する
 * - API キー: Builder が用意した Connection 枠へ値を保存し、接続テストまで行う。値は画面に残さない
 * どちらも成功すると Builder が自動で再開する。
 */
export function ConnectionAction({ action, connectorName, onChanged }: { action: HumanActionDto; connectorName: string; onChanged: () => Promise<void> }) {
  if (action.type === "oauth_consent" && action.oauth_start_url) {
    return <OAuthConsent action={action} connectorName={connectorName} />;
  }
  if (action.type === "enter_secret" && action.connection_id) {
    return <SecretEntry action={action} connectorName={connectorName} onChanged={onChanged} />;
  }
  return null;
}

function OAuthConsent({ action, connectorName }: { action: HumanActionDto; connectorName: string }) {
  const { can } = useSession();
  const [startUrl, setStartUrl] = useState(action.oauth_start_url ?? "");
  // API が返す URL は公開ベース URL 基準。画面と同じオリジンで開く
  useEffect(() => {
    if (!action.oauth_start_url) return;
    try {
      const url = new URL(action.oauth_start_url);
      setStartUrl(`${url.pathname}${url.search}`);
    } catch {
      setStartUrl(action.oauth_start_url);
    }
  }, [action.oauth_start_url]);
  const [configured, setConfigured] = useState(action.oauth_app_configured ?? true);

  if (!configured && action.connector_id) {
    return (
      <ConnectorOAuthAppSetup
        connectorId={action.connector_id}
        connectorName={connectorName}
        consoleUrl={action.oauth_app_console_url}
        canConfigure={can("organization.edit")}
        onConfigured={() => setConfigured(true)}
        startUrl={startUrl}
      />
    );
  }
  return (
    <div className="space-y-3 rounded-lg border border-indigo-100 bg-indigo-50/50 px-4 py-4">
      <p className="text-sm text-gray-800">{connectorName}の画面が開きます。許可すると自動でこの画面に戻り、作成を再開します。</p>
      {action.scopes?.length ? (
        <p className="text-xs text-gray-600">要求する権限: {action.scopes.join("、")}（必要なものだけです）</p>
      ) : null}
      <ButtonLink href={startUrl} icon={<Link2 className="h-4 w-4" aria-hidden="true" />}>{connectorName}に接続する</ButtonLink>
    </div>
  );
}

function SecretEntry({ action, connectorName, onChanged }: { action: HumanActionDto; connectorName: string; onChanged: () => Promise<void> }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = useActionMutation(setConnectionSecretAction, { errorToast: false });
  const validate = useActionMutation(validateConnectionAction, { successMessage: `${connectorName}に接続しました。作成を再開します`, onSuccess: onChanged });
  const field = action.fields.find((candidate) => candidate.secret) ?? action.fields[0];
  const pending = save.pending || validate.pending;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!value.trim() || !action.connection_id) return;
    const saved = await save.mutate(action.connection_id, {
      value: value.trim(),
      mcp_server_url: action.mcp_server_url,
    });
    // 成功しても失敗しても、入力した値は手元に残さない
    setValue("");
    if (!saved.ok) {
      setError(saved.error.message || "認証情報を保存できませんでした");
      return;
    }
    const validated = await validate.mutate(action.connection_id);
    if (validated.ok && validated.data.status !== "connected") {
      setError("認証情報を保存しましたが、接続を確認できませんでした。値を確認してもう一度お試しください");
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-indigo-100 bg-indigo-50/50 px-4 py-4" noValidate>
      <div className="flex items-start gap-2 text-sm text-gray-800">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" aria-hidden="true" />
        <p>
          値はAgent StudioのSecret領域だけに保存され、Agentやチャットには表示されません。
          {action.secret_help_url ? (
            <>
              {" "}
              <a className="font-medium text-accent-700 underline" href={action.secret_help_url} target="_blank" rel="noreferrer">
                取得方法を見る <ExternalLink className="inline h-3 w-3" aria-hidden="true" />
              </a>
            </>
          ) : null}
        </p>
      </div>
      <Field label={field?.label ?? `${connectorName}のAPIキー`} required hint={action.secret_header_name ? `送信ヘッダ: ${action.secret_header_name}（自動設定）` : undefined} error={error ?? undefined}>
        <Input type="password" value={value} autoComplete="new-password" onChange={(event) => setValue(event.target.value)} placeholder="ここに貼り付け" />
      </Field>
      <div className="flex justify-end">
        <Button type="submit" loading={pending} disabled={!value.trim()}>保存して接続を確認</Button>
      </div>
    </form>
  );
}

/** Provider 側の OAuth アプリを運営者が一度だけ登録する（Qiita 専用だった処理の汎用版）。 */
export function ConnectorOAuthAppSetup({
  connectorId,
  connectorName,
  consoleUrl,
  canConfigure,
  onConfigured,
  startUrl,
}: {
  connectorId: string;
  connectorName: string;
  consoleUrl?: string;
  canConfigure: boolean;
  onConfigured: () => void;
  startUrl: string;
}) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("/integrations/oauth/callback");
  useEffect(() => setCallbackUrl(`${window.location.origin}/integrations/oauth/callback`), []);
  const save = useActionMutation(setConnectorOAuthAppAction, {
    successMessage: `${connectorName}のOAuthアプリを安全に保存しました。接続へ進みます`,
    onSuccess: () => {
      onConfigured();
      window.location.assign(startUrl);
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!clientId.trim() || !clientSecret) return;
    void save.mutate(connectorId, { client_id: clientId.trim(), client_secret: clientSecret });
    setClientSecret("");
  };

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50/70 px-4 py-4">
      <p className="text-sm font-semibold text-gray-900">{connectorName}を利用可能にする（この組織で初回のみ）</p>
      <p className="mt-1 text-xs leading-relaxed text-gray-600">
        この準備はAgentごとではなく、組織で最初の1回だけです。完了後、他の利用者は「{connectorName}に接続する」を押すだけになります。
      </p>
      {!canConfigure ? (
        <Alert className="mt-3" tone="warning">組織のオーナーにこの初回設定を依頼してください。設定が終わると、ここから続行できます。</Alert>
      ) : (
        <form className="mt-3 space-y-3" onSubmit={submit}>
          <ol className="list-decimal space-y-1 pl-5 text-xs leading-relaxed text-gray-700">
            <li>
              {consoleUrl ? (
                <a className="font-medium text-accent-700 underline" href={consoleUrl} target="_blank" rel="noreferrer">
                  {connectorName}でOAuthアプリを登録 <ExternalLink className="inline h-3 w-3" aria-hidden="true" />
                </a>
              ) : `${connectorName}の開発者向け画面でOAuthアプリを登録します`}
            </li>
            <li>リダイレクト先（Callback）URLに次を指定します。</li>
          </ol>
          <code className="block break-all rounded-md border border-amber-200 bg-white px-2.5 py-2 text-xs text-gray-800">{callbackUrl}</code>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Client ID" required error={save.fieldErrors.client_id}>
              <Input value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" />
            </Field>
            <Field label="Client Secret" required hint="保存後は表示されません" error={save.fieldErrors.client_secret}>
              <Input type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} autoComplete="new-password" />
            </Field>
          </div>
          {save.error ? <Alert tone="danger">{save.error.message}</Alert> : null}
          <Button type="submit" size="sm" loading={save.pending} disabled={!clientId.trim() || !clientSecret}>
            安全に保存して{connectorName}へ接続する
          </Button>
        </form>
      )}
    </div>
  );
}
