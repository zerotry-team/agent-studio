"use client";

import { updateWorkflowSchema, type WorkflowDto } from "@agent-studio/contracts";
import { Save } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { updateWorkflowAction } from "@/actions/workflows";
import { TimeAgo } from "@/components/common/time-ago";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { useToast } from "@/hooks/use-toast";
import { zodFieldErrors } from "@/lib/utils/zod-ja";
import { focusFirstInvalid, toDrafts, toStepErrors, toSteps, validateSteps, type StepDraft } from "./step-drafts";
import { WorkflowStepEditor } from "./step-editor";

export interface WorkflowDefinitionFormProps {
  workflow: WorkflowDto;
  /** ワークフローを編集できるか（できない人には読み取り専用で表示する） */
  editable: boolean;
  onSaved: (workflow: WorkflowDto) => void;
}

function validateName(name: string, steps: StepDraft[]): string | undefined {
  if (!name.trim()) return "名前を入力してください";
  const result = updateWorkflowSchema.safeParse({ name, definition: { steps: toSteps(steps) } });
  return result.success ? undefined : zodFieldErrors(result.error).name;
}

/** ワークフローの定義（名前とステップ）。保存するとバージョンが上がる */
export function WorkflowDefinitionForm({ workflow, editable, onSaved }: WorkflowDefinitionFormProps) {
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const [name, setName] = useState(workflow.name);
  const [steps, setSteps] = useState<StepDraft[]>(() => toDrafts(workflow.definition.steps));
  const [submitted, setSubmitted] = useState(false);

  const mutation = useActionMutation(updateWorkflowAction, {
    successMessage: (saved) => `保存しました（バージョン ${saved.version}）`,
    onSuccess: onSaved,
  });

  const original = useMemo(() => JSON.stringify(toSteps(toDrafts(workflow.definition.steps))), [workflow.definition.steps]);
  const dirty = name.trim() !== workflow.name || JSON.stringify(toSteps(steps)) !== original;

  // 保存していない変更があるときは、ページを離れる前に確認する
  useEffect(() => {
    if (!dirty || !editable) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty, editable]);

  if (!editable) {
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader title="基本情報" />
          <CardBody>
            <DescriptionList
              items={[
                { label: "名前", value: workflow.name },
                { label: "キー", value: <span className="font-mono">{workflow.key}</span> },
                { label: "バージョン", value: `バージョン ${workflow.version}` },
                { label: "作成", value: <TimeAgo value={workflow.created_at} /> },
              ]}
            />
          </CardBody>
        </Card>
        <section aria-labelledby="workflow-definition-steps" className="space-y-3">
          <h2 id="workflow-definition-steps" className="text-base font-semibold text-gray-900">
            ステップ
          </h2>
          <p className="text-sm text-gray-500">定義を変更できるのは、ワークフローを編集する権限を持つメンバーだけです。</p>
          <WorkflowStepEditor steps={steps} onChange={setSteps} readOnly />
        </section>
      </div>
    );
  }

  const nameError = (submitted ? validateName(name, steps) : undefined) ?? mutation.fieldErrors.name;
  const stepErrors = { ...toStepErrors(mutation.fieldErrors, "definition"), ...(submitted ? validateSteps(steps) : {}) };

  const reset = () => {
    setName(workflow.name);
    setSteps(toDrafts(workflow.definition.steps));
    setSubmitted(false);
    mutation.reset();
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitted(true);
    const invalid = !!validateName(name, steps) || Object.keys(validateSteps(steps)).length > 0;
    if (invalid) {
      toast.error("入力内容を確認してください");
      if (formRef.current) focusFirstInvalid(formRef.current);
      return;
    }
    const res = await mutation.mutate(workflow.id, { name: name.trim(), definition: { steps: toSteps(steps) } });
    if (!res.ok && formRef.current) focusFirstInvalid(formRef.current);
  };

  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate className="space-y-6">
      <Alert tone="info" title={`保存すると、バージョンが ${workflow.version + 1} になります`}>
        実行中のワークフローは、開始したときのバージョンの定義のまま最後まで進みます。
      </Alert>

      <Card>
        <CardHeader title="基本情報" />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label="名前" required error={nameError}>
            <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} disabled={mutation.pending} />
          </Field>
          <Field label="キー" hint="キーはあとから変更できません。">
            <Input value={workflow.key} readOnly className="font-mono" />
          </Field>
        </CardBody>
      </Card>

      <section aria-labelledby="workflow-definition-steps" className="space-y-3">
        <div>
          <h2 id="workflow-definition-steps" className="text-base font-semibold text-gray-900">
            ステップ
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-gray-500">
            上から順番に進みます。承認のステップでは、承認されるまで次へ進みません。
          </p>
        </div>
        <WorkflowStepEditor steps={steps} onChange={setSteps} errors={stepErrors} disabled={mutation.pending} />
      </section>

      <div className="sticky bottom-0 z-10 -mx-4 flex flex-col gap-3 border-t border-gray-200 bg-white/95 px-4 py-3 backdrop-blur sm:mx-0 sm:flex-row sm:items-center sm:justify-between sm:rounded-xl sm:border sm:px-5 sm:shadow-sm">
        <p className="text-sm text-gray-600" role="status">
          {dirty ? "保存していない変更があります。" : "変更はありません。"}
        </p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          {dirty ? (
            <Button variant="ghost" onClick={reset} disabled={mutation.pending}>
              変更を取り消す
            </Button>
          ) : null}
          <Button type="submit" loading={mutation.pending} disabled={!dirty} icon={<Save className="h-4 w-4" aria-hidden="true" />}>
            保存する
          </Button>
        </div>
      </div>
    </form>
  );
}
