"use client";

import { createWorkflowSchema } from "@agent-studio/contracts";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { createWorkflowAction } from "@/actions/workflows";
import { Forbidden } from "@/components/common/forbidden";
import { PageHeader } from "@/components/common/page-header";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { useSession } from "@/hooks/use-session";
import { WorkflowStepEditor } from "@/components/workflows/step-editor";
import { focusFirstInvalid, newAgentStep, toStepErrors, toSteps, validateSteps, type StepDraft } from "@/components/workflows/step-drafts";
import { zodFieldErrors } from "@/lib/utils/zod-ja";

const BACK = { href: "/workflows", label: "ワークフロー" };

function validateBasics(input: { key: string; name: string; steps: StepDraft[] }): Record<string, string> {
  const errors: Record<string, string> = {};
  const result = createWorkflowSchema.safeParse({ key: input.key.trim(), name: input.name, definition: { steps: toSteps(input.steps) } });
  if (!result.success) {
    const all = zodFieldErrors(result.error);
    if (all.key) errors.key = all.key;
    if (all.name) errors.name = all.name;
  }
  if (!input.name.trim()) errors.name = "名前を入力してください";
  if (!input.key.trim()) errors.key = "キーを入力してください";
  return errors;
}

function NewWorkflowForm() {
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [steps, setSteps] = useState<StepDraft[]>(() => [newAgentStep([])]);
  const [submitted, setSubmitted] = useState(false);

  const mutation = useActionMutation(createWorkflowAction, {
    successMessage: "ワークフローを作成しました",
    onSuccess: (workflow) => router.push(`/workflows/${workflow.id}`),
  });

  // 一度送信したあとは、入力に合わせてエラーを更新する
  const basicErrors = submitted ? validateBasics({ key, name, steps }) : {};
  const stepErrors = submitted ? validateSteps(steps) : {};
  const serverStepErrors = toStepErrors(mutation.fieldErrors, "definition");

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitted(true);
    const errors = { ...validateBasics({ key, name, steps }), ...validateSteps(steps) };
    if (Object.keys(errors).length > 0) {
      toast.error("入力内容を確認してください");
      if (formRef.current) focusFirstInvalid(formRef.current);
      return;
    }
    const res = await mutation.mutate({ key: key.trim(), name: name.trim(), definition: { steps: toSteps(steps) } });
    if (!res.ok && formRef.current) focusFirstInvalid(formRef.current);
  };

  return (
    <>
      <PageHeader
        title="ワークフローを作る"
        description="エージェントの実行と承認を、上から順番に進める流れを作ります。"
        back={BACK}
      />
      <form ref={formRef} onSubmit={onSubmit} noValidate className="space-y-6">
        <Card>
          <CardHeader title="基本情報" />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label="名前" required error={basicErrors.name ?? mutation.fieldErrors.name}>
              <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="例: 価格変更の承認フロー" />
            </Field>
            <Field
              label="キー"
              required
              error={basicErrors.key ?? mutation.fieldErrors.key}
              hint="半角英小文字・数字・ハイフンで入力してください（例: price-review）。あとから変更できません。"
            >
              <Input
                value={key}
                maxLength={63}
                onChange={(e) => setKey(e.target.value)}
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                placeholder="price-review"
              />
            </Field>
          </CardBody>
        </Card>

        <section aria-labelledby="workflow-steps-heading" className="space-y-3">
          <div>
            <h2 id="workflow-steps-heading" className="text-base font-semibold text-gray-900">
              ステップ
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-gray-500">
              上から順番に進みます。承認のステップでは、承認されるまで次へ進みません。
            </p>
          </div>
          <WorkflowStepEditor
            steps={steps}
            onChange={setSteps}
            errors={{ ...serverStepErrors, ...stepErrors }}
            disabled={mutation.pending}
          />
        </section>

        <div className="flex flex-col-reverse gap-2 border-t border-gray-200 pt-5 sm:flex-row sm:justify-end">
          <ButtonLink href="/workflows">キャンセル</ButtonLink>
          <Button type="submit" loading={mutation.pending}>
            作成する
          </Button>
        </div>
      </form>
    </>
  );
}

export default function NewWorkflowPage() {
  const { can } = useSession();
  if (!can("workflow.edit")) {
    return (
      <>
        <PageHeader title="ワークフローを作る" back={BACK} />
        <Forbidden description="ワークフローを作るには、ワークフローを作成・編集できる権限が必要です。組織の管理者に問い合わせてください。" />
      </>
    );
  }
  return <NewWorkflowForm />;
}
