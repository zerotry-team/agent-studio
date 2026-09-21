"use client";

import {
  createGitHubAppConnectionSchema,
  type ConnectionDto,
  type CreateGitHubAppConnectionInput,
} from "@agent-studio/contracts";
import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { createGitHubAppConnectionAction } from "@/actions/connections";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { zodFieldErrors } from "@/lib/utils/zod-ja";

interface FormState {
  name: string;
  appId: string;
  privateKey: string;
  webhookSecret: string;
  installationId: string;
  repositoryId: string;
  owner: string;
  repository: string;
  packageSigningPublicKey: string;
}

const initial: FormState = {
  name: "GitHub Adapter Repository",
  appId: "",
  privateKey: "",
  webhookSecret: "",
  installationId: "",
  repositoryId: "",
  owner: "",
  repository: "",
  packageSigningPublicKey: "",
};

function parse(form: FormState): { input: CreateGitHubAppConnectionInput | null; errors: Record<string, string> } {
  const parsed = createGitHubAppConnectionSchema.safeParse({
    name: form.name.trim(),
    app_id: form.appId.trim(),
    private_key: form.privateKey.trim(),
    webhook_secret: form.webhookSecret,
    installation_id: form.installationId.trim(),
    repository_id: form.repositoryId.trim(),
    owner: form.owner.trim(),
    repository: form.repository.trim(),
    package_signing_public_key: form.packageSigningPublicKey.trim(),
    permissions: { administration: "write", contents: "write", pull_requests: "write", checks: "read", metadata: "read" },
  });
  return parsed.success ? { input: parsed.data, errors: {} } : { input: null, errors: zodFieldErrors(parsed.error) };
}

export function CreateGitHubAppConnectionDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (connection: ConnectionDto) => void;
}) {
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [form, setForm] = useState<FormState>(initial);
  const [showErrors, setShowErrors] = useState(false);
  const mutation = useActionMutation(createGitHubAppConnectionAction, {
    successMessage: "GitHub Appを接続しました",
    onSuccess: onCreated,
  });
  const validation = useMemo(() => parse(form), [form]);
  const errors = { ...mutation.fieldErrors, ...(showErrors ? validation.errors : {}) };
  const update = (patch: Partial<FormState>) => {
    setForm((current) => ({ ...current, ...patch }));
    if (mutation.error) mutation.reset();
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setShowErrors(true);
    if (!validation.input) {
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
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
      title="GitHub Appを接続"
      description="Adapter専用repositoryを1つだけ許可します。秘密鍵とWebhook secretはSecret Storeへ直接保存し、この画面やDBから再表示できません。"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.pending}>キャンセル</Button>
          <Button type="submit" form={formId} loading={mutation.pending}>検証して接続</Button>
        </>
      }
    >
      <form id={formId} ref={formRef} onSubmit={submit} noValidate className="space-y-5">
        <Field label="接続名" required error={errors.name}>
          <Input data-autofocus value={form.name} maxLength={100} onChange={(event) => update({ name: event.target.value })} autoComplete="off" />
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="App ID" required error={errors.app_id}>
            <Input value={form.appId} onChange={(event) => update({ appId: event.target.value })} inputMode="numeric" autoComplete="off" />
          </Field>
          <Field label="Installation ID" required error={errors.installation_id}>
            <Input value={form.installationId} onChange={(event) => update({ installationId: event.target.value })} inputMode="numeric" autoComplete="off" />
          </Field>
          <Field label="Repository owner" required error={errors.owner}>
            <Input value={form.owner} onChange={(event) => update({ owner: event.target.value })} autoCapitalize="off" spellCheck={false} autoComplete="off" />
          </Field>
          <Field label="Repository name" required error={errors.repository}>
            <Input value={form.repository} onChange={(event) => update({ repository: event.target.value })} autoCapitalize="off" spellCheck={false} autoComplete="off" />
          </Field>
          <Field label="Repository ID" required error={errors.repository_id} hint="名前変更の影響を受けないGitHubの数値IDです。">
            <Input value={form.repositoryId} onChange={(event) => update({ repositoryId: event.target.value })} inputMode="numeric" autoComplete="off" />
          </Field>
        </div>
        <Field label="Private key（PEM）" required error={errors.private_key} hint="保存後は再表示できません。Installation tokenは必要なpushの直前に短時間だけ発行します。">
          <Textarea rows={7} value={form.privateKey} onChange={(event) => update({ privateKey: event.target.value })} className="font-mono text-xs" autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Adapter package署名公開鍵（Ed25519 PEM）" required error={errors.package_signing_public_key} hint="CIが作るattestationの署名検証に使います。公開鍵だけを入力し、対応する秘密鍵はCI側で管理してください。">
          <Textarea rows={5} value={form.packageSigningPublicKey} onChange={(event) => update({ packageSigningPublicKey: event.target.value })} className="font-mono text-xs" autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Webhook secret" required error={errors.webhook_secret}>
          <Input type="password" value={form.webhookSecret} onChange={(event) => update({ webhookSecret: event.target.value })} autoComplete="new-password" />
        </Field>
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs leading-relaxed text-gray-600">
          固定権限: Administration write（企業専用private Repositoryの自動作成）/ Contents write / Pull requests write / Checks read / Metadata read。GitHub Appは「All repositories」でインストールしてください。default branchはGitHubから自動取得し、直接push、force push、tag pushは行いません。
        </div>
      </form>
    </Dialog>
  );
}
