"use client";

import { sendRunMessageSchema } from "@agent-studio/contracts";
import { Send } from "lucide-react";
import { useState, type FormEvent, type KeyboardEvent } from "react";
import { sendRunMessageAction } from "@/actions/runs";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { zodFieldErrors } from "@/lib/utils/zod-ja";

const MAX_LENGTH = 20_000;

export interface RunMessageFormProps {
  runId: string;
  /** 送信できたとき（経過の自動更新を再開する） */
  onSent?: () => void;
}

/** 実行中・完了したエージェントに追加の指示を送る */
export function RunMessageForm({ runId, onSent }: RunMessageFormProps) {
  const [input, setInput] = useState("");
  const [clientError, setClientError] = useState<string | null>(null);
  const mutation = useActionMutation(sendRunMessageAction, {
    successMessage: "追加の指示を送りました",
    onSuccess: () => {
      setInput("");
      onSent?.();
    },
  });

  const submit = async () => {
    if (mutation.pending) return;
    const parsed = sendRunMessageSchema.safeParse({ input });
    if (!parsed.success) {
      setClientError(zodFieldErrors(parsed.error).input ?? "入力内容を確認してください");
      return;
    }
    setClientError(null);
    await mutation.mutate(runId, parsed.data);
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void submit();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <Card>
      <CardBody>
        <form onSubmit={onSubmit} className="space-y-3" noValidate>
          <Field
            label="追加の指示"
            hint="エージェントに続けて伝えたいことを入力してください。Ctrl + Enter（Mac は ⌘ + Enter）でも送信できます。"
            error={clientError ?? mutation.fieldErrors.input}
          >
            <Textarea
              rows={3}
              value={input}
              maxLength={MAX_LENGTH}
              onChange={(e) => {
                setInput(e.target.value);
                if (clientError) setClientError(null);
              }}
              onKeyDown={onKeyDown}
              placeholder="例: 変更の前に、対象の商品の一覧を見せてください"
            />
          </Field>
          <div className="flex justify-end">
            <Button
              type="submit"
              loading={mutation.pending}
              disabled={input.trim() === ""}
              icon={<Send className="h-4 w-4" aria-hidden="true" />}
            >
              送信
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
