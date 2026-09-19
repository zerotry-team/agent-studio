"use client";

import { createEvalCaseSchema, type EvalCaseDto } from "@agent-studio/contracts";
import { useId, useState, type FormEvent } from "react";
import { createEvalCaseAction } from "@/actions/evals";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { zodFieldErrors } from "@/lib/utils/zod-ja";

/** 1 行に 1 つの入力を配列にする（前後の空白を取り、空の行は除く） */
function toLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** "expectations.must_contain.3" のような子の項目のエラーもまとめて拾う */
function errorFor(errors: Record<string, string>, path: string): string | undefined {
  if (errors[path]) return errors[path];
  const key = Object.keys(errors).find((k) => k.startsWith(`${path}.`));
  return key ? errors[key] : undefined;
}

export interface EvalCaseDialogProps {
  agentId: string;
  onClose: () => void;
  onCreated: (created: EvalCaseDto) => void;
}

/** テストケースの追加（開くたびに作り直すので、表示するときだけ描画する） */
export function EvalCaseDialog({ agentId, onClose, onCreated }: EvalCaseDialogProps) {
  const formId = useId();
  const [name, setName] = useState("");
  const [input, setInput] = useState("");
  const [mustContain, setMustContain] = useState("");
  const [mustNotContain, setMustNotContain] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  const create = useActionMutation(createEvalCaseAction, {
    successMessage: (c) => `テストケース「${c.name}」を追加しました`,
    onSuccess: (c) => {
      onCreated(c);
      onClose();
    },
  });

  const allErrors = { ...create.fieldErrors, ...errors };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (create.pending) return;
    const payload = {
      name: name.trim(),
      input: input.trim(),
      expectations: { must_contain: toLines(mustContain), must_not_contain: toLines(mustNotContain) },
    };
    const parsed = createEvalCaseSchema.safeParse(payload);
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    setErrors({});
    void create.mutate(agentId, payload);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      busy={create.pending}
      size="lg"
      title="テストケースを追加"
      description="エージェントに渡す指示と、出力で確かめたいことを登録します。テストを実行すると、登録したすべてのケースをまとめて確かめます。"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={create.pending}>
            キャンセル
          </Button>
          <Button type="submit" form={formId} loading={create.pending}>
            追加する
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} noValidate className="space-y-5">
        <Field label="テストケースの名前" required error={allErrors.name}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="例: 400円の値下げ" data-autofocus />
        </Field>
        <Field label="エージェントへの指示" required error={allErrors.input}>
          <Textarea rows={4} value={input} onChange={(e) => setInput(e.target.value)} placeholder="例: 商品Xの価格を400円下げてください" />
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="出力に含まれるべき語"
            optional
            error={errorFor(allErrors, "expectations.must_contain")}
            hint="1 行に 1 つずつ入力してください（20 個まで）。"
          >
            <Textarea rows={4} value={mustContain} onChange={(e) => setMustContain(e.target.value)} placeholder={"変更前\n変更後"} />
          </Field>
          <Field
            label="出力に含まれてはいけない語"
            optional
            error={errorFor(allErrors, "expectations.must_not_contain")}
            hint="1 行に 1 つずつ入力してください（20 個まで）。"
          >
            <Textarea rows={4} value={mustNotContain} onChange={(e) => setMustNotContain(e.target.value)} placeholder={"エラー\n失敗しました"} />
          </Field>
        </div>
      </form>
    </Dialog>
  );
}
