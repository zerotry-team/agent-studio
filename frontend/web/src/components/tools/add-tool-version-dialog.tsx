"use client";

import { toolVersionSpecSchema, type ToolDto, type ToolVersionDto, type ToolVersionSpec } from "@agent-studio/contracts";
import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { createToolVersionAction } from "@/actions/tools";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { zodFieldErrors } from "@/lib/utils/zod-ja";
import { buildToolSpec, draftFromSpec, emptyToolSpecDraft, specRelativeErrors, type ToolSpecDraft } from "./tool-spec";
import { ToolSpecForm } from "./tool-spec-form";

export interface AddToolVersionDialogProps {
  tool: ToolDto;
  /** 最新のバージョンの設定（フォームの初期値にする） */
  latestSpec: ToolVersionSpec | null;
  onClose: () => void;
  onCreated: (version: ToolVersionDto) => void;
}

function validate(draft: ToolSpecDraft): { spec: ToolVersionSpec | null; errors: Record<string, string> } {
  const built = buildToolSpec(draft);
  const parsed = toolVersionSpecSchema.safeParse(built.spec ?? {});
  const errors: Record<string, string> = parsed.success ? {} : zodFieldErrors(parsed.error);
  Object.assign(errors, built.errors);
  const ok = parsed.success && Object.keys(built.errors).length === 0;
  return { spec: ok && parsed.success ? parsed.data : null, errors };
}

/**
 * 新しいバージョンを追加するダイアログ。表示するたびに作り直す（開いている間だけ描画する）ことで、
 * 毎回最新のバージョンの設定から始まるようにする。
 */
export function AddToolVersionDialog({ tool, latestSpec, onClose, onCreated }: AddToolVersionDialogProps) {
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<ToolSpecDraft>(() =>
    latestSpec ? draftFromSpec(latestSpec) : emptyToolSpecDraft(tool.execution_location),
  );
  const [showErrors, setShowErrors] = useState(false);
  const nextVersion = tool.latest_version + 1;
  const mutation = useActionMutation(createToolVersionAction, {
    successMessage: (v) => `バージョン ${v.version} を追加しました`,
    onSuccess: (v) => onCreated(v),
  });

  const validation = useMemo(() => validate({ ...draft, execution_location: tool.execution_location }), [draft, tool.execution_location]);
  const errors = { ...specRelativeErrors(mutation.fieldErrors), ...(showErrors ? validation.errors : {}) };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setShowErrors(true);
    if (!validation.spec) {
      requestAnimationFrame(() => {
        formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      });
      return;
    }
    await mutation.mutate(tool.id, { spec: validation.spec });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      busy={mutation.pending}
      title="新しいバージョンを追加"
      description={`${tool.display_name}（${tool.name}）のバージョン ${nextVersion} を作ります。`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.pending}>
            キャンセル
          </Button>
          <Button type="submit" form={formId} loading={mutation.pending}>
            バージョン {nextVersion} として保存
          </Button>
        </>
      }
    >
      <form id={formId} ref={formRef} onSubmit={submit} noValidate className="space-y-6">
        <Alert tone="info">
          エージェントの定義で <code className="font-mono">{`${tool.name}@${tool.latest_version}`}</code>{" "}
          のようにバージョンを指定している場合は、そのバージョンを使い続けます。バージョンを指定せずに{" "}
          <code className="font-mono">{tool.name}</code> と書いている場合は、次にデプロイしたときから新しいバージョンが使われます。
        </Alert>
        <ToolSpecForm
          value={draft}
          onChange={(next) => {
            setDraft(next);
            if (mutation.error) mutation.reset();
          }}
          errors={errors}
          fixedLocation={tool.execution_location}
          disabled={mutation.pending}
          autoFocusDescription
        />
      </form>
    </Dialog>
  );
}
