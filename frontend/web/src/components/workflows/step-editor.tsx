"use client";

import type { DeploymentDto } from "@agent-studio/contracts";
import { ArrowDown, ArrowUp, Bot, Plus, ShieldCheck, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { listDeploymentsAction } from "@/actions/deployments";
import { deploymentLabel } from "@/components/runs/deployment-label";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DescriptionList } from "@/components/ui/description-list";
import { Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { useActionQuery, type ActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";
import { cn } from "@/lib/utils/cn";
import { DEPLOYMENT_STATUS } from "@/lib/utils/labels";
import {
  GENERAL_STEP_ERROR,
  MAX_STEPS,
  newAgentStep,
  newApprovalStep,
  referencedStepKeys,
  STEP_TYPE_LABELS,
  type StepDraft,
} from "./step-drafts";

type AgentDraft = Extract<StepDraft, { type: "agent" }>;
type ApprovalDraft = Extract<StepDraft, { type: "approval" }>;
type DraftPatch = Partial<Omit<AgentDraft, "uid" | "type">> & Partial<Omit<ApprovalDraft, "uid" | "type">>;

type PendingFocus = { uid: string; target: "name" | "up" | "down" };

export interface WorkflowStepEditorProps {
  steps: StepDraft[];
  onChange: (steps: StepDraft[]) => void;
  /** キーは "steps.<番号>.<項目>"。ステップ全体のエラーは "steps" */
  errors?: Record<string, string>;
  /** 編集できない人向けの表示 */
  readOnly?: boolean;
  disabled?: boolean;
}

/** ワークフローのステップ（エージェントの実行・承認）を上から順に編集する */
export function WorkflowStepEditor({ steps, onChange, errors = {}, readOnly = false, disabled = false }: WorkflowStepEditorProps) {
  const { organization } = useSession();
  const deployments = useActionQuery(() => listDeploymentsAction(), [organization?.id]);
  const [removing, setRemoving] = useState<StepDraft | null>(null);
  const [pendingFocus, setPendingFocus] = useState<PendingFocus | null>(null);
  const focusTargets = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    if (!pendingFocus) return;
    const el = focusTargets.current.get(`${pendingFocus.uid}:${pendingFocus.target}`);
    if (el && !(el as HTMLButtonElement).disabled) el.focus();
    else focusTargets.current.get(`${pendingFocus.uid}:name`)?.focus();
    setPendingFocus(null);
  }, [pendingFocus]);

  const registerFocus = (uid: string, target: PendingFocus["target"]) => (el: HTMLElement | null) => {
    const k = `${uid}:${target}`;
    if (el) focusTargets.current.set(k, el);
    else focusTargets.current.delete(k);
  };

  const update = (uid: string, patch: DraftPatch) => {
    onChange(steps.map((s) => (s.uid === uid ? ({ ...s, ...patch } as StepDraft) : s)));
  };

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    const current = steps[index];
    const other = steps[target];
    if (!current || !other) return;
    const next = [...steps];
    next[index] = other;
    next[target] = current;
    onChange(next);
    setPendingFocus({ uid: current.uid, target: delta < 0 ? "up" : "down" });
  };

  const add = (type: StepDraft["type"]) => {
    if (steps.length >= MAX_STEPS) return;
    const step = type === "agent" ? newAgentStep(steps) : newApprovalStep(steps);
    onChange([...steps, step]);
    setPendingFocus({ uid: step.uid, target: "name" });
  };

  const remove = (uid: string) => {
    const index = steps.findIndex((s) => s.uid === uid);
    const next = steps.filter((s) => s.uid !== uid);
    onChange(next);
    const neighbor = next[Math.min(index, next.length - 1)];
    if (neighbor) setPendingFocus({ uid: neighbor.uid, target: "name" });
  };

  const generalError = errors[GENERAL_STEP_ERROR];
  const atMax = steps.length >= MAX_STEPS;

  return (
    <div className="space-y-4">
      {generalError ? (
        <Alert tone="danger" title="ステップを確認してください">
          {generalError}
        </Alert>
      ) : null}

      {!readOnly && deployments.error ? (
        <Alert
          tone="warning"
          title="デプロイの一覧を読み込めませんでした"
          action={
            <Button variant="secondary" size="sm" onClick={() => void deployments.reload()} loading={deployments.refreshing}>
              再読み込み
            </Button>
          }
        >
          {deployments.error.message}
        </Alert>
      ) : null}

      {steps.length === 0 ? (
        <p className="rounded-xl border border-dashed border-gray-300 px-5 py-8 text-center text-sm text-gray-500">
          ステップがありません。{readOnly ? "" : "下のボタンから追加してください。"}
        </p>
      ) : (
        <ol className="space-y-0" aria-label="ワークフローのステップ">
          {steps.map((step, index) => (
            <li key={step.uid}>
              {index > 0 ? (
                <div className="flex justify-center py-1.5" aria-hidden="true">
                  <ArrowDown className="h-4 w-4 text-gray-300" />
                </div>
              ) : null}
              <StepCard
                step={step}
                index={index}
                total={steps.length}
                previous={steps.slice(0, index)}
                errors={errors}
                readOnly={readOnly}
                disabled={disabled}
                deployments={deployments}
                onUpdate={(patch) => update(step.uid, patch)}
                onMove={(delta) => move(index, delta)}
                onRemove={() => setRemoving(step)}
                registerFocus={registerFocus}
              />
            </li>
          ))}
        </ol>
      )}

      {!readOnly ? (
        <div className="flex flex-col gap-2 rounded-xl border border-dashed border-gray-300 bg-gray-50/60 px-4 py-4 sm:flex-row sm:items-center">
          <Button
            variant="secondary"
            onClick={() => add("agent")}
            disabled={disabled || atMax}
            icon={<Plus className="h-4 w-4" aria-hidden="true" />}
          >
            エージェントの実行を追加
          </Button>
          <Button
            variant="secondary"
            onClick={() => add("approval")}
            disabled={disabled || atMax}
            icon={<Plus className="h-4 w-4" aria-hidden="true" />}
          >
            承認を追加
          </Button>
          <p className="text-xs text-gray-500 sm:ml-auto">
            {atMax ? `ステップは${MAX_STEPS}個までです。` : `ステップは${MAX_STEPS}個まで追加できます（現在 ${steps.length}個）。`}
          </p>
        </div>
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="このステップを削除しますか？"
        description={
          removing
            ? `「${removing.name.trim() || STEP_TYPE_LABELS[removing.type]}」と、入力した内容を削除します。保存するまでは、ワークフローには反映されません。`
            : undefined
        }
        confirmLabel="削除する"
        onConfirm={() => {
          if (removing) remove(removing.uid);
        }}
      />
    </div>
  );
}

interface StepCardProps {
  step: StepDraft;
  index: number;
  total: number;
  previous: StepDraft[];
  errors: Record<string, string>;
  readOnly: boolean;
  disabled: boolean;
  deployments: ActionQuery<DeploymentDto[]>;
  onUpdate: (patch: DraftPatch) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  registerFocus: (uid: string, target: PendingFocus["target"]) => (el: HTMLElement | null) => void;
}

function StepCard({
  step,
  index,
  total,
  previous,
  errors,
  readOnly,
  disabled,
  deployments,
  onUpdate,
  onMove,
  onRemove,
  registerFocus,
}: StepCardProps) {
  const p = `steps.${index}`;
  const TypeIcon = step.type === "agent" ? Bot : ShieldCheck;
  const hasError = Object.keys(errors).some((k) => k === p || k.startsWith(`${p}.`));
  const stepError = errors[p];

  return (
    <section
      aria-label={`ステップ ${index + 1}`}
      className={cn("rounded-xl border bg-white shadow-sm", hasError && !readOnly ? "border-red-200" : "border-gray-200")}
    >
      <div className="flex items-center gap-3 border-b border-gray-100 px-4 py-3">
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-50 text-sm font-semibold text-accent-700"
          aria-hidden="true"
        >
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-gray-900">{step.name.trim() || "（名前を入力してください）"}</p>
          <p className="mt-0.5 flex items-center gap-1 text-xs text-gray-500">
            <TypeIcon className="h-3.5 w-3.5" aria-hidden="true" />
            {STEP_TYPE_LABELS[step.type]}
          </p>
        </div>
        {!readOnly ? (
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              ref={registerFocus(step.uid, "up")}
              variant="ghost"
              size="icon-sm"
              aria-label="上へ移動"
              title="上へ移動"
              onClick={() => onMove(-1)}
              disabled={disabled || index === 0}
            >
              <ArrowUp className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button
              ref={registerFocus(step.uid, "down")}
              variant="ghost"
              size="icon-sm"
              aria-label="下へ移動"
              title="下へ移動"
              onClick={() => onMove(1)}
              disabled={disabled || index === total - 1}
            >
              <ArrowDown className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="このステップを削除"
              title="このステップを削除"
              onClick={onRemove}
              disabled={disabled || total <= 1}
              className="text-gray-500 hover:bg-red-50 hover:text-red-600"
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        ) : null}
      </div>

      <div className="space-y-4 px-4 py-4 sm:px-5">
        {stepError && !readOnly ? <p className="text-xs font-medium text-red-600" role="alert">{stepError}</p> : null}
        {readOnly ? (
          <StepReadOnly step={step} deployments={deployments.data} />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="名前" required error={errors[`${p}.name`]}>
                <Input
                  ref={registerFocus(step.uid, "name")}
                  value={step.name}
                  maxLength={100}
                  onChange={(e) => onUpdate({ name: e.target.value })}
                  placeholder={step.type === "agent" ? "例: 価格の変更案を作る" : "例: 担当者の確認"}
                  disabled={disabled}
                />
              </Field>
              <Field
                label="キー"
                required
                error={errors[`${p}.key`]}
                hint="半角英小文字・数字・ハイフン。あとのステップでこの結果を使うときの名前になります。"
              >
                <Input
                  value={step.key}
                  maxLength={63}
                  onChange={(e) => onUpdate({ key: e.target.value })}
                  className="font-mono"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={disabled}
                />
              </Field>
            </div>
            {step.type === "agent" ? (
              <AgentStepFields step={step} index={index} previous={previous} errors={errors} disabled={disabled} deployments={deployments} onUpdate={onUpdate} />
            ) : (
              <Field
                label="承認者へのメッセージ"
                required
                error={errors[`${p}.message`]}
                hint="承認者に確認してほしいことを書いてください。承認されると次のステップへ進みます。"
              >
                <Textarea
                  rows={3}
                  value={step.message}
                  maxLength={2000}
                  onChange={(e) => onUpdate({ message: e.target.value })}
                  placeholder="例: 変更案の内容を確認して、問題がなければ承認してください"
                  disabled={disabled}
                />
              </Field>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function deploymentOptionLabel(deployment: DeploymentDto): string {
  const label = deploymentLabel(deployment);
  return deployment.status === "active" ? label : `${label}（${DEPLOYMENT_STATUS[deployment.status].label}）`;
}

function AgentStepFields({
  step,
  index,
  previous,
  errors,
  disabled,
  deployments,
  onUpdate,
}: {
  step: AgentDraft;
  index: number;
  previous: StepDraft[];
  errors: Record<string, string>;
  disabled: boolean;
  deployments: ActionQuery<DeploymentDto[]>;
  onUpdate: (patch: DraftPatch) => void;
}) {
  const p = `steps.${index}`;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const touched = useRef(false);

  const all = deployments.data;
  const active = all?.filter((d) => d.status === "active") ?? [];
  const selected = step.deployment_id ? all?.find((d) => d.id === step.deployment_id) : undefined;
  const selectedInactive = !!step.deployment_id && !!all && (!selected || selected.status !== "active");

  const insert = (token: string) => {
    const el = textareaRef.current;
    const value = step.input_template;
    const start = el && touched.current ? el.selectionStart : value.length;
    const end = el && touched.current ? el.selectionEnd : value.length;
    onUpdate({ input_template: value.slice(0, start) + token + value.slice(end) });
    const caret = start + token.length;
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
      touched.current = true;
    });
  };

  const previousKeys = new Set(previous.map((s) => s.key.trim()));
  const unknownRefs = referencedStepKeys(step.input_template).filter((k) => !previousKeys.has(k));

  let deploymentHint: ReactNode = "稼働中のデプロイから選べます。";
  if (selectedInactive) {
    deploymentHint = <span className="text-amber-700">選ばれているデプロイは現在使われていません。稼働中のデプロイを選び直してください。</span>;
  } else if (all && active.length === 0) {
    deploymentHint = (
      <>
        稼働中のデプロイがありません。先に{" "}
        <Link href="/agents" className="font-medium text-accent-700 underline">
          エージェント
        </Link>{" "}
        をデプロイしてください。
      </>
    );
  }

  return (
    <>
      <Field label="どのデプロイを実行しますか？" required error={errors[`${p}.deployment_id`]} hint={deploymentHint}>
        <Select value={step.deployment_id} onChange={(e) => onUpdate({ deployment_id: e.target.value })} disabled={disabled}>
          <option value="">{all === undefined && !deployments.error ? "読み込み中…" : "選んでください"}</option>
          {step.deployment_id && !active.some((d) => d.id === step.deployment_id) ? (
            <option value={step.deployment_id}>{selected ? deploymentOptionLabel(selected) : "現在は見つからないデプロイ"}</option>
          ) : null}
          {active.map((d) => (
            <option key={d.id} value={d.id}>
              {deploymentLabel(d)}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="エージェントへの入力"
        required
        error={errors[`${p}.input_template`]}
        hint={
          <>
            <span className="font-mono">{"{{input}}"}</span> はワークフローへの入力に、
            <span className="font-mono">{"{{steps.<キー>.output}}"}</span> は前のステップの結果に置き換わります。
          </>
        }
      >
        <Textarea
          ref={textareaRef}
          mono
          rows={5}
          value={step.input_template}
          maxLength={20000}
          onChange={(e) => onUpdate({ input_template: e.target.value })}
          onFocus={() => {
            touched.current = true;
          }}
          placeholder={"例: 次の依頼内容をもとに、変更案を作ってください。\n{{input}}"}
          disabled={disabled}
        />
      </Field>

      <div className="-mt-1 space-y-2">
        <p className="text-xs font-medium text-gray-500">入力欄のカーソルの位置に挿入する</p>
        <div className="flex flex-wrap gap-2">
          <InsertButton onClick={() => insert("{{input}}")} disabled={disabled} label="ワークフローへの入力" token="{{input}}" />
          {previous.map((s) => {
            const key = s.key.trim();
            const name = s.name.trim() || STEP_TYPE_LABELS[s.type];
            return (
              <InsertButton
                key={s.uid}
                onClick={() => insert(`{{steps.${key}.output}}`)}
                disabled={disabled || !key}
                label={`「${name}」の結果`}
                token={key ? `{{steps.${key}.output}}` : "キーを入力すると使えます"}
              />
            );
          })}
        </div>
      </div>

      {unknownRefs.length > 0 ? (
        <Alert tone="warning">
          {unknownRefs.map((k) => `steps.${k}`).join("、")} は、このステップより前にありません。キーの綴りやステップの順番を確認してください。
        </Alert>
      ) : null}
    </>
  );
}

function InsertButton({ onClick, disabled, label, token }: { onClick: () => void; disabled: boolean; label: string; token: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={token}
      aria-label={`${label}を挿入`}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border border-accent-200 bg-accent-50 px-3 py-1 text-xs font-medium text-accent-700 transition-colors",
        "hover:bg-accent-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500",
        "disabled:cursor-not-allowed disabled:opacity-50",
      )}
    >
      <Plus className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </button>
  );
}

function StepReadOnly({ step, deployments }: { step: StepDraft; deployments: DeploymentDto[] | undefined }) {
  if (step.type === "approval") {
    return (
      <DescriptionList
        columns={1}
        items={[
          { label: "キー", value: <span className="font-mono">{step.key}</span> },
          { label: "承認者へのメッセージ", value: <span className="whitespace-pre-wrap">{step.message}</span> },
        ]}
      />
    );
  }
  const deployment = deployments?.find((d) => d.id === step.deployment_id);
  return (
    <DescriptionList
      columns={1}
      items={[
        { label: "キー", value: <span className="font-mono">{step.key}</span> },
        {
          label: "実行するデプロイ",
          value: deployment ? deploymentOptionLabel(deployment) : deployments ? "見つからないデプロイ" : "読み込み中…",
        },
        {
          label: "エージェントへの入力",
          value: (
            <pre className="whitespace-pre-wrap break-words rounded-lg border border-gray-200 bg-gray-50 p-3 font-mono text-[12.5px] leading-relaxed text-gray-800">
              {step.input_template}
            </pre>
          ),
        },
      ]}
    />
  );
}
