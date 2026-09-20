"use client";

import { setConnectionSecretSchema, type ConnectionDto } from "@agent-studio/contracts";
import { useId, useState, type FormEvent } from "react";
import { setConnectionSecretAction } from "@/actions/connections";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { CONNECTION_SCOPE_LABELS } from "@/lib/utils/labels";
import { zodFieldErrors } from "@/lib/utils/zod-ja";

export interface SetConnectionSecretDialogProps {
  /** scope が studio / openai_vault の接続先 */
  connection: ConnectionDto;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * 認証情報の値を設定するダイアログ（書き込み専用）。
 * 値は画面に表示せず、送信後と閉じたとき（このコンポーネントが消えるとき）に手元から消す。
 */
export function SetConnectionSecretDialog({ connection, onClose, onSaved }: SetConnectionSecretDialogProps) {
  const formId = useId();
  const isVault = connection.scope === "openai_vault";
  const [value, setValue] = useState("");
  const [mcpServerUrl, setMcpServerUrl] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const mutation = useActionMutation(setConnectionSecretAction, {
    successMessage: `「${connection.name}」の認証情報を保存しました`,
  });
  const shownErrors = { ...mutation.fieldErrors, ...errors };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const url = mcpServerUrl.trim();
    const input = {
      value,
      mcp_server_url: isVault ? url || undefined : undefined,
      expires_at: expiresAt ? new Date(expiresAt).toISOString() : undefined,
    };
    const parsed = setConnectionSecretSchema.safeParse(input);
    const next: Record<string, string> = parsed.success ? {} : zodFieldErrors(parsed.error);
    if (!value) next.value = "認証情報の値を入力してください";
    if (isVault && !url) next.mcp_server_url = "この認証情報を使う MCP サーバーの URL を入力してください";
    else if (next.mcp_server_url) next.mcp_server_url = "URL の形式が正しくありません（例: https://mcp.example.com/mcp）";
    setErrors(next);
    if (!parsed.success || Object.keys(next).length > 0) return;

    const res = await mutation.mutate(connection.id, parsed.data);
    // 成功しても失敗しても、入力した値は手元に残さない
    setValue("");
    if (res.ok) onSaved();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      busy={mutation.pending}
      title="認証情報を設定"
      description={`接続先「${connection.name}」の認証情報を保存します（${CONNECTION_SCOPE_LABELS[connection.scope]}）。`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.pending}>
            キャンセル
          </Button>
          <Button type="submit" form={formId} loading={mutation.pending}>
            保存する
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-5">
        {connection.has_secret ? (
          <Alert tone="warning" title="すでに設定されている値を上書きします">
            保存すると、いま設定されている認証情報は新しい値に置き換わります。いまの値は表示できません。
          </Alert>
        ) : (
          <Alert tone="info">保存した値は、あとから画面で見ることはできません。変更するときは、もう一度入力して上書きします。</Alert>
        )}

        <Field
          label="認証情報の値"
          required
          error={shownErrors.value}
          hint={
            isVault ? (
              "MCP サーバーに送るアクセストークンを入力してください。"
            ) : (
              <>
                ヘッダ <code className="font-mono">{connection.header_name ?? "Authorization"}</code>{" "}
                の値としてそのまま送ります。Bearer 形式の場合は「Bearer 」から入力してください。
              </>
            )
          }
        >
          <Input
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            autoCapitalize="off"
            maxLength={10000}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (mutation.error) mutation.reset();
            }}
            data-autofocus
          />
        </Field>

        {isVault ? (
          <Field
            label="この認証情報を使う MCP サーバーの URL"
            required
            error={shownErrors.mcp_server_url}
            hint="OpenAI の保管庫は URL で照合します。ツールの「サーバーの URL」と同じ URL を入力してください。"
          >
            <Input
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://mcp.example.com/mcp"
              value={mcpServerUrl}
              onChange={(e) => {
                setMcpServerUrl(e.target.value);
                if (mutation.error) mutation.reset();
              }}
            />
          </Field>
        ) : null}

        <Field
          label="有効期限"
          error={shownErrors.expires_at}
          hint="任意。期限を過ぎると自動で利用を停止します。サービス側のトークン期限に合わせてください。"
        >
          <Input
            type="datetime-local"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}
