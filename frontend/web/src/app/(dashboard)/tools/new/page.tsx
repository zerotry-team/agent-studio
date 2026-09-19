"use client";

import { createToolInputSchema, type CreateToolInput } from "@agent-studio/contracts";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { createToolAction } from "@/actions/tools";
import { Forbidden } from "@/components/common/forbidden";
import { PageHeader } from "@/components/common/page-header";
import { buildToolSpec, emptyToolSpecDraft, specRelativeErrors, type ToolSpecDraft } from "@/components/tools/tool-spec";
import { ToolSpecForm } from "@/components/tools/tool-spec-form";
import { Alert } from "@/components/ui/alert";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { useSession } from "@/hooks/use-session";
import { zodFieldErrors } from "@/lib/utils/zod-ja";

const BACK = { href: "/tools", label: "ツールの一覧" };

interface Validation {
  input: CreateToolInput | null;
  /** "name" / "display_name" / "spec.xxx" の形のエラー */
  errors: Record<string, string>;
}

function validate(name: string, displayName: string, draft: ToolSpecDraft): Validation {
  const built = buildToolSpec(draft);
  const parsed = createToolInputSchema.safeParse({
    name: name.trim(),
    display_name: displayName.trim(),
    spec: built.spec ?? {},
  });
  const errors: Record<string, string> = parsed.success ? {} : zodFieldErrors(parsed.error);
  for (const [path, message] of Object.entries(built.errors)) errors[`spec.${path}`] = message;
  if (!displayName.trim()) errors.display_name = "表示名を入力してください";
  if (!name.trim()) errors.name = "ツール名を入力してください";
  const ok = parsed.success && Object.keys(built.errors).length === 0;
  return { input: ok && parsed.success ? parsed.data : null, errors };
}

export default function NewToolPage() {
  const { can } = useSession();
  if (!can("tool.edit")) {
    return (
      <>
        <PageHeader title="ツールを登録" back={BACK} />
        <Forbidden description="ツールの登録は、作成者以上の権限を持つメンバーだけが行えます。" />
      </>
    );
  }
  return <CreateToolForm />;
}

function CreateToolForm() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [displayName, setDisplayName] = useState("");
  const [name, setName] = useState("");
  const [draft, setDraft] = useState<ToolSpecDraft>(() => emptyToolSpecDraft());
  const [showErrors, setShowErrors] = useState(false);
  const mutation = useActionMutation(createToolAction, { successMessage: "ツールを登録しました" });

  const validation = useMemo(() => validate(name, displayName, draft), [name, displayName, draft]);
  const errors = { ...mutation.fieldErrors, ...(showErrors ? validation.errors : {}) };
  const specErrors = specRelativeErrors(errors);
  const trimmedName = name.trim() || "tool_name";

  const touched = () => {
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
    const res = await mutation.mutate(validation.input);
    if (res.ok) router.push(`/tools/${res.data.id}`);
  };

  const hasErrors = showErrors && Object.keys(validation.errors).length > 0;

  return (
    <>
      <PageHeader
        title="ツールを登録"
        back={BACK}
        description="エージェントに使わせたい操作を、ツールとして登録します。登録した内容はバージョン 1 になり、あとから新しいバージョンを追加できます。"
      />
      <form ref={formRef} onSubmit={submit} noValidate className="space-y-6">
        {hasErrors ? (
          <Alert tone="danger" title="入力内容を確認してください">
            正しく入力されていない項目があります。赤く表示されている項目を直してください。
          </Alert>
        ) : null}

        <Card>
          <CardHeader title="基本情報" description="一覧に表示する名前と、エージェントの定義から参照するときの名前です。" />
          <CardBody className="grid gap-5 sm:grid-cols-2">
            <Field label="表示名" required error={errors.display_name} hint="一覧や画面に表示される名前です（例: 商品の価格を変更）。">
              <Input
                value={displayName}
                maxLength={100}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                  touched();
                }}
                autoComplete="off"
              />
            </Field>
            <Field
              label="ツール名"
              required
              error={errors.name}
              hint={
                <>
                  半角英小文字・数字・アンダースコア（_）で、英字から始めます。登録後は変えられません。エージェントの定義からは{" "}
                  <code className="font-mono text-gray-700">{trimmedName}</code> または{" "}
                  <code className="font-mono text-gray-700">{trimmedName}@1</code> のように参照します。
                </>
              }
            >
              <Input
                value={name}
                maxLength={64}
                onChange={(e) => {
                  setName(e.target.value);
                  touched();
                }}
                className="font-mono"
                placeholder="update_price"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="ツールの内容" description="エージェントに伝える説明と、ツールがどこで動くかを設定します。" />
          <CardBody>
            <ToolSpecForm
              value={draft}
              onChange={(next) => {
                setDraft(next);
                touched();
              }}
              errors={specErrors}
              disabled={mutation.pending}
            />
          </CardBody>
          <CardFooter>
            <ButtonLink href="/tools" variant="secondary">
              キャンセル
            </ButtonLink>
            <Button type="submit" loading={mutation.pending}>
              登録する
            </Button>
          </CardFooter>
        </Card>
      </form>
    </>
  );
}
