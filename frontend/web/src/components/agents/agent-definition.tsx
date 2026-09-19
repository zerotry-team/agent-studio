"use client";

import type { AgentDto, AgentVersionDto } from "@agent-studio/contracts";
import { Pencil, Save } from "lucide-react";
import { useState, type FormEvent } from "react";
import { createAgentVersionAction } from "@/actions/agents";
import { AgentVersionStatusBadge } from "@/components/common/status-badges";
import { TimeAgo } from "@/components/common/time-ago";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { CodeBlock } from "@/components/ui/code-block";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/input";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { useSession } from "@/hooks/use-session";
import { AGENT_VERSION_STATUS } from "@/lib/utils/labels";
import { ManifestEditor, type ManifestValidationState } from "./manifest-editor";

export interface AgentDefinitionProps {
  agent: AgentDto;
  /** 新しいバージョンを保存したあとにエージェントを読み込み直す */
  onSaved: () => Promise<void>;
}

export function AgentDefinition({ agent, onSaved }: AgentDefinitionProps) {
  const { can } = useSession();
  const canEdit = can("agent.edit");
  const versions = agent.versions ?? [];
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const current = versions.find((v) => v.version === selectedVersion) ?? versions[0];

  const [editing, setEditing] = useState<AgentVersionDto | null>(null);

  if (!current) {
    return (
      <Card>
        <CardBody>
          <p className="text-sm text-gray-500">バージョンがまだありません。</p>
        </CardBody>
      </Card>
    );
  }

  if (editing) {
    return (
      <DefinitionEditor
        agent={agent}
        base={editing}
        onCancel={() => setEditing(null)}
        onSaved={async (saved) => {
          await onSaved();
          setSelectedVersion(saved.version);
          setEditing(null);
        }}
      />
    );
  }

  return (
    <Card>
      <CardHeader
        title="定義（YAML）"
        description="公開したバージョンは変更できません。定義を直すときは、いつも新しいバージョン（下書き）として保存します。"
        actions={
          canEdit ? (
            <Button variant="primary" icon={<Pencil className="h-4 w-4" aria-hidden="true" />} onClick={() => setEditing(current)}>
              編集して新しいバージョンを作る
            </Button>
          ) : null
        }
      />
      <CardBody className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <Field label="表示するバージョン" className="sm:w-72">
            <Select value={current.version} onChange={(e) => setSelectedVersion(Number(e.target.value))}>
              {versions.map((v, i) => (
                <option key={v.id} value={v.version}>
                  v{v.version}（{AGENT_VERSION_STATUS[v.status].label}
                  {i === 0 ? "・最新" : ""}）
                </option>
              ))}
            </Select>
          </Field>
          <p className="flex flex-wrap items-center gap-2 text-sm text-gray-500">
            <AgentVersionStatusBadge status={current.status} />
            <span>
              作成 <TimeAgo value={current.created_at} />
            </span>
            {current.published_at ? (
              <span>
                ・公開 <TimeAgo value={current.published_at} />
              </span>
            ) : null}
          </p>
        </div>
        <CodeBlock
          code={current.manifest_yaml}
          copyable
          maxHeight="36rem"
          label={`バージョン ${current.version} の定義（YAML）`}
        />
      </CardBody>
    </Card>
  );
}

function DefinitionEditor({
  agent,
  base,
  onCancel,
  onSaved,
}: {
  agent: AgentDto;
  base: AgentVersionDto;
  onCancel: () => void;
  onSaved: (version: AgentVersionDto) => Promise<void>;
}) {
  const [draft, setDraft] = useState(base.manifest_yaml);
  const [validation, setValidation] = useState<ManifestValidationState | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const save = useActionMutation(createAgentVersionAction, {
    successMessage: (v) => `バージョン ${v.version} を保存しました`,
    onSuccess: onSaved,
  });

  const dirty = draft !== base.manifest_yaml;
  const status = validation?.status ?? "checking";
  const canSave = dirty && status !== "invalid" && status !== "empty";

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSave || save.pending) return;
    void save.mutate(agent.id, { manifest: draft });
  };

  const cancel = () => {
    if (dirty) setConfirmDiscard(true);
    else onCancel();
  };

  const saveErrors = save.error
    ? Object.keys(save.fieldErrors).length > 0
      ? save.fieldErrors
      : { "": save.error.message }
    : undefined;

  return (
    <Card>
      <form onSubmit={onSubmit} noValidate>
        <CardHeader
          title={`v${base.version} をもとに新しいバージョンを作る`}
          description={
            <>
              公開したバージョンは変更できないため、編集した内容は新しいバージョン（v{agent.latest_version + 1}・下書き）として保存されます。キー（agent.key）は変更できません。
            </>
          }
        />
        <CardBody>
          <ManifestEditor
            value={draft}
            onChange={(value) => {
              setDraft(value);
              if (save.error) save.reset();
            }}
            onValidationChange={setValidation}
            expectedKey={agent.key}
            disabled={save.pending}
            saveErrors={saveErrors}
          />
        </CardBody>
        <CardFooter>
          {!dirty ? <p className="text-xs text-gray-500 sm:mr-2">内容を変更すると保存できます</p> : null}
          <Button variant="secondary" onClick={cancel} disabled={save.pending}>
            キャンセル
          </Button>
          <Button type="submit" loading={save.pending} disabled={!canSave} icon={<Save className="h-4 w-4" aria-hidden="true" />}>
            新しいバージョンとして保存
          </Button>
        </CardFooter>
      </form>

      <ConfirmDialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        onConfirm={onCancel}
        title="編集中の内容を破棄しますか？"
        description="保存していない変更は失われます。"
        confirmLabel="破棄する"
        cancelLabel="編集を続ける"
      />
    </Card>
  );
}
