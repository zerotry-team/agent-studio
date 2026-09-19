"use client";

import type { BootstrapTokenDto, RuntimeDto } from "@agent-studio/contracts";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { CopyButton } from "@/components/ui/copy-button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatDateTime } from "@/lib/utils/format";
import { bootstrapTokenCommand, runtimeSecretsLocation, TENANT_PLACEHOLDER } from "./runtime-secrets";

export interface BootstrapTokenDialogProps {
  runtime: RuntimeDto;
  /** 発行した登録用トークン（平文はこの応答でしか受け取れない） */
  token: BootstrapTokenDto;
  /** 閉じたら、呼び出し側でトークンを手元から消す */
  onClose: () => void;
}

/** 発行した登録用トークンを一度だけ表示するダイアログ */
export function BootstrapTokenDialog({ runtime, token, onClose }: BootstrapTokenDialogProps) {
  const location = runtimeSecretsLocation(runtime);
  const command = bootstrapTokenCommand(location, token.token);

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="登録用トークンを発行しました"
      description={`Runtime「${runtime.name}」を Agent Studio に登録するためのトークンです。`}
      footer={
        <Button variant="primary" onClick={onClose}>
          閉じる
        </Button>
      }
    >
      <div className="space-y-5 text-sm leading-relaxed text-gray-700">
        <Alert tone="warning" title="この画面を閉じると、トークンは二度と表示できません">
          このトークンはこの画面でしか表示されません。有効期限は {formatDateTime(token.expires_at)} です。一度だけ使えます。
        </Alert>

        <Field label="登録用トークン">
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={token.token}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 font-mono text-[13px]"
              spellCheck={false}
              autoComplete="off"
              data-autofocus
            />
            <CopyButton value={token.token} className="h-10 shrink-0" />
          </div>
        </Field>

        <div className="space-y-2">
          <p className="font-medium text-gray-800">AWS の Secrets Manager に設定するコマンド</p>
          <CodeBlock code={command} copyable dark label="登録用トークンを設定するコマンド" />
          <p className="text-xs text-gray-500">
            御社の AWS アカウント（<span className="font-mono">{runtime.aws_account_id}</span>）で実行してください。リージョンは{" "}
            <span className="font-mono">{runtime.aws_region}</span> です。AWS CLI の既定のリージョンが異なる場合は、
            <code className="font-mono">--region {runtime.aws_region}</code> を付けてください。
          </p>
        </div>

        {location.tenant ? null : (
          <Alert tone="info" title={`${TENANT_PLACEHOLDER} を置き換えてください`}>
            IAM ロール名（<span className="font-mono">{runtime.expected_role_name}</span>）からテナントの短い名前を読み取れませんでした。コマンドの{" "}
            <code className="font-mono">{TENANT_PLACEHOLDER}</code> を、Runtime を作ったときの設定（config.yaml の short_name）の値に置き換えてください。
          </Alert>
        )}

        <div className="rounded-lg bg-gray-50 px-4 py-3">
          <p className="font-medium text-gray-800">このあとの流れ</p>
          <p className="mt-1">
            Runtime Controller が起動時にトークンを読み取り、AWS の身元確認と合わせて登録します。登録が終わるとこの画面の状態が「接続済み」に変わります。
          </p>
        </div>
      </div>
    </Dialog>
  );
}
