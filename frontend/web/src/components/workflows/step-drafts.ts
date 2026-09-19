import { workflowDefinitionSchema, type WorkflowStep } from "@agent-studio/contracts";
import { zodFieldErrors } from "@/lib/utils/zod-ja";

/** 画面で編集中のステップ（並べ替えても入力欄がずれないように uid を持つ） */
export type StepDraft =
  | { uid: string; type: "agent"; key: string; name: string; deployment_id: string; input_template: string }
  | { uid: string; type: "approval"; key: string; name: string; message: string };

export type StepType = StepDraft["type"];

export const MAX_STEPS = 20;

export const STEP_TYPE_LABELS: Record<StepType, string> = {
  agent: "エージェントを実行",
  approval: "承認を待つ",
};

/** ステップのエラーのキー（例: steps.0.key）。ステップ全体に関するエラーは "steps" */
export const GENERAL_STEP_ERROR = "steps";

let uidCounter = 0;
function newUid(): string {
  uidCounter += 1;
  return `draft-${uidCounter}`;
}

export function toDrafts(steps: readonly WorkflowStep[]): StepDraft[] {
  return steps.map((step) => ({ ...step, uid: newUid() }));
}

/** API に送る形にする（余分な項目を含めない） */
export function toSteps(drafts: readonly StepDraft[]): WorkflowStep[] {
  return drafts.map((d) =>
    d.type === "agent"
      ? { type: "agent", key: d.key.trim(), name: d.name.trim(), deployment_id: d.deployment_id, input_template: d.input_template }
      : { type: "approval", key: d.key.trim(), name: d.name.trim(), message: d.message },
  );
}

/** 新しいステップのキーの候補（step-1, step-2 …） */
export function suggestStepKey(drafts: readonly StepDraft[]): string {
  const used = new Set(drafts.map((d) => d.key.trim()));
  let n = drafts.length + 1;
  while (used.has(`step-${n}`)) n += 1;
  return `step-${n}`;
}

export function newAgentStep(drafts: readonly StepDraft[]): StepDraft {
  return { uid: newUid(), type: "agent", key: suggestStepKey(drafts), name: "", deployment_id: "", input_template: drafts.length === 0 ? "{{input}}" : "" };
}

export function newApprovalStep(drafts: readonly StepDraft[]): StepDraft {
  return { uid: newUid(), type: "approval", key: suggestStepKey(drafts), name: "", message: "" };
}

/** 入力テンプレートの中の {{steps.<key>.output}} のキー */
export function referencedStepKeys(template: string): string[] {
  const keys = new Set<string>();
  for (const match of template.matchAll(/\{\{\s*steps\.([^.}\s]+)\.output\s*\}\}/g)) {
    if (match[1]) keys.add(match[1]);
  }
  return [...keys];
}

/**
 * サーバー（または createWorkflowSchema）のエラーを、ステップ編集部品のキーに合わせる。
 * 例: "definition.steps.0.key" → "steps.0.key"、"definition" → "steps"
 */
export function toStepErrors(errors: Record<string, string>, prefix = "definition"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, message] of Object.entries(errors)) {
    let rest: string | null = null;
    if (prefix === "") rest = path;
    else if (path === prefix) rest = "";
    else if (path.startsWith(`${prefix}.`)) rest = path.slice(prefix.length + 1);
    if (rest === null) continue;
    const key = rest === "" ? GENERAL_STEP_ERROR : rest;
    if (!(key in out)) out[key] = message;
  }
  return out;
}

/** ステップの定義を検証し、エラーを「steps.<番号>.<項目>」ごとに返す（問題がなければ空） */
export function validateSteps(drafts: readonly StepDraft[]): Record<string, string> {
  const errors: Record<string, string> = {};

  // 分かりやすいメッセージを先に決める（未入力・重複）
  const keyCount = new Map<string, number>();
  for (const d of drafts) {
    const k = d.key.trim();
    if (k) keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
  }
  drafts.forEach((d, i) => {
    const p = `steps.${i}`;
    if (!d.name.trim()) errors[`${p}.name`] = "ステップの名前を入力してください";
    const key = d.key.trim();
    if (!key) errors[`${p}.key`] = "キーを入力してください";
    else if ((keyCount.get(key) ?? 0) > 1) errors[`${p}.key`] = "ほかのステップと同じキーです。別のキーにしてください";
    if (d.type === "agent") {
      if (!d.deployment_id) errors[`${p}.deployment_id`] = "実行するデプロイを選んでください";
      if (!d.input_template.trim()) errors[`${p}.input_template`] = "エージェントへの入力を入力してください";
    } else if (!d.message.trim()) {
      errors[`${p}.message`] = "承認者へのメッセージを入力してください";
    }
  });

  const result = workflowDefinitionSchema.safeParse({ steps: toSteps(drafts) });
  if (!result.success) {
    const hasDuplicate = [...keyCount.values()].some((n) => n > 1);
    for (const [path, message] of Object.entries(zodFieldErrors(result.error))) {
      // キーの重複（パスなし）は各ステップに表示済み
      if (path === "" && hasDuplicate) continue;
      const key = path === "" ? GENERAL_STEP_ERROR : path;
      if (!(key in errors)) errors[key] = message;
    }
  }
  return errors;
}

/** 画面の中で最初のエラーの入力欄にフォーカスを移す */
export function focusFirstInvalid(root: ParentNode = document): void {
  requestAnimationFrame(() => {
    const el = root.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (el) {
      el.focus();
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  });
}
