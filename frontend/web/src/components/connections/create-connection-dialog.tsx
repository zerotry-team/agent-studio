"use client";

import {
  createConnectionSchema,
  type ConnectionDto,
  type ConnectionScope,
  type CreateConnectionInput,
  type RuntimeDto,
} from "@agent-studio/contracts";
import { Building2, Cloud, KeyRound } from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { createConnectionAction } from "@/actions/connections";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { RadioCards, type RadioCardOption } from "@/components/ui/radio-cards";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { CONNECTION_SCOPE_LABELS, STAGE_LABELS } from "@/lib/utils/labels";
import { zodFieldErrors } from "@/lib/utils/zod-ja";

const SCOPE_OPTIONS: RadioCardOption<ConnectionScope>[] = [
  {
    value: "studio",
    label: CONNECTION_SCOPE_LABELS.studio,
    description: "Agent Studio の保管庫に暗号化して保管し、Webhook の送信時にヘッダとして付けます。",
    icon: KeyRound,
  },
  {
    value: "openai_vault",
    label: CONNECTION_SCOPE_LABELS.openai_vault,
    description: "OpenAI の保管庫（vault）に保管し、公開 MCP サーバーへの接続に使います。",
    icon: Cloud,
  },
  {
    value: "runtime",
    label: CONNECTION_SCOPE_LABELS.runtime,
    description: "自社の AWS の Secrets Manager に保管します。値は Agent Studio に送られません。",
    icon: Building2,
  },
];

export interface CreateConnectionDialogProps {
  /** 選べる Runtime（読み込み中は undefined） */
  runtimes: RuntimeDto[] | undefined;
  /** Runtime の一覧を読み込めなかった */
  runtimesFailed?: boolean;
  onClose: () => void;
  onCreated: (connection: ConnectionDto) => void;
}

interface FormState {
  name: string;
  description: string;
  scope: ConnectionScope | null;
  headerName: string;
  runtimeId: string;
  runtimeSecretName: string;
}

function validate(form: FormState): { input: CreateConnectionInput | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!form.scope) {
    errors.scope = "認証情報をどこに保管するかを選んでください";
    if (!form.name.trim()) errors.name = "名前を入力してください";
    return { input: null, errors };
  }
  const payload = {
    name: form.name.trim(),
    description: form.description.trim() || undefined,
    scope: form.scope,
    header_name: form.scope === "studio" ? form.headerName.trim() || undefined : undefined,
    runtime_id: form.scope === "runtime" ? form.runtimeId || undefined : undefined,
    runtime_secret_name: form.scope === "runtime" ? form.runtimeSecretName.trim() || undefined : undefined,
  };
  const parsed = createConnectionSchema.safeParse(payload);
  if (!parsed.success) Object.assign(errors, zodFieldErrors(parsed.error));

  // 形式の誤りは、何を直せばよいか分かる言葉にする
  if (!payload.name) errors.name = "名前を入力してください";
  if (errors.header_name) errors.header_name = "半角英数字とハイフン（-）で入力してください（例: Authorization）";
  if (form.scope === "runtime") {
    delete errors.runtime_id;
    if (!payload.runtime_id) errors.runtime_id = "Runtime を選んでください";
    if (!payload.runtime_secret_name) errors.runtime_secret_name = "シークレット名を入力してください";
    else if (errors.runtime_secret_name) {
      errors.runtime_secret_name = "半角英小文字・数字・ハイフン（-）で入力してください（例: sap-api-key）";
    }
  }
  const ok = parsed.success && Object.keys(errors).length === 0;
  return { input: ok && parsed.success ? parsed.data : null, errors };
}

/** 接続先を登録するダイアログ（開いている間だけ描画する） */
export function CreateConnectionDialog({ runtimes, runtimesFailed = false, onClose, onCreated }: CreateConnectionDialogProps) {
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [form, setForm] = useState<FormState>({
    name: "",
    description: "",
    scope: null,
    headerName: "",
    runtimeId: "",
    runtimeSecretName: "",
  });
  const [showErrors, setShowErrors] = useState(false);
  const mutation = useActionMutation(createConnectionAction, {
    successMessage: (c) => `接続先「${c.name}」を登録しました`,
    onSuccess: (c) => onCreated(c),
  });

  const usableRuntimes = useMemo(() => (runtimes ?? []).filter((r) => r.status !== "revoked"), [runtimes]);
  const validation = useMemo(() => validate(form), [form]);
  const errors = { ...mutation.fieldErrors, ...(showErrors ? validation.errors : {}) };

  const update = (patch: Partial<FormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
    if (mutation.error) mutation.reset();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setShowErrors(true);
    if (!validation.input) {
      requestAnimationFrame(() => {
        formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      });
      return;
    }
    await mutation.mutate(validation.input);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      busy={mutation.pending}
      title="接続先を登録"
      description="社内システムや外部サービスに接続するための認証情報の保管場所を登録します。認証情報の値は、登録したあとに設定します。"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.pending}>
            キャンセル
          </Button>
          <Button type="submit" form={formId} loading={mutation.pending}>
            登録する
          </Button>
        </>
      }
    >
      <form id={formId} ref={formRef} onSubmit={submit} noValidate className="space-y-5">
        <Field label="名前" required error={errors.name} hint="組織の中で重ならない名前にしてください（例: 在庫システム、Slack 通知）。">
          <Input
            value={form.name}
            maxLength={100}
            onChange={(e) => update({ name: e.target.value })}
            autoComplete="off"
            data-autofocus
          />
        </Field>
        <Field label="説明" optional error={errors.description}>
          <Textarea
            rows={2}
            maxLength={1000}
            value={form.description}
            onChange={(e) => update({ description: e.target.value })}
            placeholder="何に使う接続先かを書いておくと、あとで分かりやすくなります"
          />
        </Field>

        <RadioCards
          legend="認証情報をどこに保管しますか？"
          options={SCOPE_OPTIONS}
          value={form.scope}
          onChange={(scope) => update({ scope })}
          error={errors.scope}
        />

        {form.scope === "studio" ? (
          <Field
            label="送信するヘッダ名"
            optional
            error={errors.header_name}
            hint="認証情報をどのヘッダに入れて送るかです。空欄の場合は Authorization になります。"
          >
            <Input
              value={form.headerName}
              onChange={(e) => update({ headerName: e.target.value })}
              placeholder="Authorization"
              className="font-mono"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </Field>
        ) : null}

        {form.scope === "runtime" ? (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="Runtime"
              required
              error={errors.runtime_id}
              hint={
                !runtimes && runtimesFailed ? (
                  "Runtime の一覧を読み込めませんでした。画面を再読み込みしてから、もう一度お試しください。"
                ) : runtimes && usableRuntimes.length === 0 ? (
                  <>
                    使える Runtime がありません。
                    <Link href="/environments/new" className="font-medium text-accent-700 hover:underline">
                      実行環境を作る
                    </Link>
                  </>
                ) : (
                  "認証情報を保管する AWS の実行環境です。"
                )
              }
            >
              <Select
                value={form.runtimeId}
                onChange={(e) => update({ runtimeId: e.target.value })}
                disabled={!runtimes || usableRuntimes.length === 0}
              >
                <option value="">{runtimes ? "選んでください" : runtimesFailed ? "読み込めませんでした" : "読み込み中…"}</option>
                {usableRuntimes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}（{STAGE_LABELS[r.stage]}）
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="シークレット名"
              required
              error={errors.runtime_secret_name}
              hint="半角英小文字・数字・ハイフン（-）。Runtime の設定ファイル（config.yaml の connections）と同じ名前にします。"
            >
              <Input
                value={form.runtimeSecretName}
                onChange={(e) => update({ runtimeSecretName: e.target.value })}
                placeholder="sap-api-key"
                className="font-mono"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </Field>
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}
