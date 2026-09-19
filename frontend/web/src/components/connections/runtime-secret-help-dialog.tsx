"use client";

import type { ConnectionDto, RuntimeDto } from "@agent-studio/contracts";
import Link from "next/link";
import { connectionSecretCommand, runtimeSecretsLocation, TENANT_PLACEHOLDER } from "@/components/environments/runtime-secrets";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { Dialog } from "@/components/ui/dialog";

export interface RuntimeSecretHelpDialogProps {
  /** scope が runtime の接続先 */
  connection: ConnectionDto;
  /** 接続先が使う Runtime（見つからない場合は undefined） */
  runtime: RuntimeDto | undefined;
  onClose: () => void;
}

/** 自社の AWS に保管する認証情報の登録方法（値は Agent Studio に送らない） */
export function RuntimeSecretHelpDialog({ connection, runtime, onClose }: RuntimeSecretHelpDialogProps) {
  const secretName = connection.runtime_secret_name ?? "<シークレット名>";
  const location = runtime ? runtimeSecretsLocation(runtime) : null;
  const command = connectionSecretCommand(
    { prefix: location?.prefix ?? `agent-studio/runtime/${TENANT_PLACEHOLDER}/<stage>` },
    secretName,
    runtime?.aws_region ?? "<region>",
  );

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="認証情報の登録方法"
      description={`接続先「${connection.name}」の認証情報は、御社の AWS アカウントの Secrets Manager に直接登録します。値が Agent Studio に送られることはありません。`}
      footer={
        <Button variant="secondary" onClick={onClose} data-autofocus>
          閉じる
        </Button>
      }
    >
      <div className="space-y-5 text-sm leading-relaxed text-gray-700">
        <ol className="list-decimal space-y-4 pl-5 marker:text-gray-400">
          <li>
            AWS CLI で、Runtime を動かしている AWS アカウント
            {runtime ? (
              <>
                （<span className="font-mono">{runtime.aws_account_id}</span>）
              </>
            ) : null}
            にログインします。
          </li>
          <li className="space-y-2">
            <p>
              次のコマンドの <code className="font-mono">&lt;値&gt;</code> を実際の認証情報に置き換えて実行します。
            </p>
            <CodeBlock code={command} copyable dark label="認証情報を登録するコマンド" />
          </li>
          <li>
            登録した値は、Runtime の Tool Gateway がツールを呼び出すときに読み取ります。値を変えるときも、同じコマンドで上書きします。
          </li>
        </ol>

        {!runtime ? (
          <Alert tone="warning" title="Runtime の情報を読み込めませんでした">
            <code className="font-mono">{TENANT_PLACEHOLDER}</code> はテナントの短い名前、<code className="font-mono">&lt;stage&gt;</code> は本番なら{" "}
            <code className="font-mono">prod</code>、検証用なら <code className="font-mono">stg</code>、
            <code className="font-mono">&lt;region&gt;</code> は Runtime のリージョンに置き換えてください。
          </Alert>
        ) : location && !location.tenant ? (
          <Alert tone="info" title="テナントの短い名前を置き換えてください">
            IAM ロール名（<span className="font-mono">{runtime.expected_role_name}</span>）からテナントの短い名前を読み取れませんでした。
            <code className="font-mono">{TENANT_PLACEHOLDER}</code> を、Runtime を作ったときの設定（config.yaml の short_name）の値に置き換えてください。
          </Alert>
        ) : null}

        <Alert tone="info" title="シークレットが見つからない場合">
          シークレットは、Runtime の設定ファイル（config.yaml の connections）に{" "}
          <code className="font-mono">{secretName}</code> を追加して Terraform を適用すると作られます。コマンドの履歴に値を残したくない場合は、
          <code className="font-mono">--secret-string file://ファイル名</code> の形でファイルから読み込むこともできます。
        </Alert>

        {runtime ? (
          <p className="text-xs text-gray-500">
            Runtime:{" "}
            <Link href={`/runtimes/${runtime.id}`} className="font-medium text-accent-700 hover:underline">
              {runtime.name}
            </Link>
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
