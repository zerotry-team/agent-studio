"use client";

import { parseManifest, type ManifestParseResult, type ManifestValidationDto } from "@agent-studio/contracts";
import { CircleAlert, CircleCheck, CircleDashed, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { validateManifestAction } from "@/actions/agents";
import { Alert } from "@/components/ui/alert";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useActionQuery } from "@/hooks/use-action-query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import type { ActionResult } from "@/lib/utils/action-result";
import { cn } from "@/lib/utils/cn";

export type ManifestValidationStatus = "empty" | "checking" | "valid" | "invalid" | "unverified";

export interface ManifestIssue {
  path: string;
  message: string;
}

export interface ManifestValidationState {
  status: ManifestValidationStatus;
  errors: ManifestIssue[];
  warnings: string[];
  /** status が unverified のとき: サーバーで確認できなかった理由 */
  message?: string;
}

interface ServerCheck {
  /** どの内容に対する結果か（入力が変わった直後に古い結果を使わないため） */
  source: string;
  result: ManifestValidationDto | null;
  error: string | null;
}

const EMPTY_STATE: ManifestValidationState = { status: "empty", errors: [], warnings: [] };

function checkLocally(source: string, expectedKey: string | undefined): ManifestParseResult | null {
  if (!source.trim()) return null;
  const parsed = parseManifest(source);
  if (!parsed.ok) return parsed;
  if (expectedKey && parsed.manifest.agent.key !== expectedKey) {
    return {
      ok: false,
      errors: [{ path: "agent.key", message: `キーは変更できません。「${expectedKey}」のままにしてください` }],
    };
  }
  return parsed;
}

/**
 * 定義（YAML）を入力しながらチェックする。
 * 入力が止まってから少し待ち、まずブラウザで書式を確認し、問題がなければサーバーでも確認する
 * （ツールや実行環境が登録されているかなど）。
 */
export function useManifestValidation(
  value: string,
  options: { expectedKey?: string; delayMs?: number } = {},
): ManifestValidationState {
  const { expectedKey, delayMs = 600 } = options;
  const debounced = useDebouncedValue(value, delayMs);
  const local = useMemo(() => checkLocally(debounced, expectedKey), [debounced, expectedKey]);

  const server = useActionQuery(
    async (): Promise<ActionResult<ServerCheck>> => {
      const res = await validateManifestAction({ manifest: debounced });
      return {
        ok: true,
        data: { source: debounced, result: res.ok ? res.data : null, error: res.ok ? null : res.error },
      };
    },
    [debounced],
    { enabled: local?.ok === true },
  );

  const settled = useMemo((): ManifestValidationState | null => {
    if (!local) return null;
    if (!local.ok) return { status: "invalid", errors: local.errors, warnings: [] };
    const check = server.data && server.data.source === debounced ? server.data : null;
    if (!check) return null;
    if (!check.result) return { status: "unverified", errors: [], warnings: [], message: check.error ?? undefined };
    const { ok, errors, warnings } = check.result;
    if (ok && errors.length === 0) return { status: "valid", errors: [], warnings };
    return {
      status: "invalid",
      errors: errors.length > 0 ? errors : [{ path: "", message: "定義に問題があります" }],
      warnings,
    };
  }, [local, server.data, debounced]);

  // チェック中も、直前の結果を表示しておく（表示がちらつかないように）
  const [lastSettled, setLastSettled] = useState<ManifestValidationState | null>(null);
  useEffect(() => {
    if (settled) setLastSettled(settled);
  }, [settled]);

  return useMemo((): ManifestValidationState => {
    if (!value.trim()) return EMPTY_STATE;
    if (value === debounced && settled) return settled;
    return { status: "checking", errors: lastSettled?.errors ?? [], warnings: lastSettled?.warnings ?? [] };
  }, [value, debounced, settled, lastSettled]);
}

export interface ManifestEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** チェックの結果が変わるたびに呼ばれる（保存ボタンの出し分けなどに使う） */
  onValidationChange?: (state: ManifestValidationState) => void;
  label?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  rows?: number;
  /** 既存のエージェントの新しいバージョンを作るとき: 変更できないキー */
  expectedKey?: string;
  /** 保存に失敗したときの項目ごとのエラー（パス → メッセージ） */
  saveErrors?: Record<string, string>;
}

const STATUS_VIEW: Record<ManifestValidationStatus, { className: string; icon: ReactNode }> = {
  empty: { className: "text-gray-500", icon: <CircleDashed className="h-4 w-4" aria-hidden="true" /> },
  checking: { className: "text-gray-600", icon: <Spinner className="h-4 w-4" /> },
  valid: { className: "text-emerald-700", icon: <CircleCheck className="h-4 w-4" aria-hidden="true" /> },
  invalid: { className: "text-red-700", icon: <CircleAlert className="h-4 w-4" aria-hidden="true" /> },
  unverified: { className: "text-amber-800", icon: <TriangleAlert className="h-4 w-4" aria-hidden="true" /> },
};

function statusText(state: ManifestValidationState): string {
  switch (state.status) {
    case "empty":
      return "定義を入力してください";
    case "checking":
      return "チェック中…";
    case "valid":
      return "問題はありません";
    case "invalid":
      return `${state.errors.length} 件の問題があります`;
    case "unverified":
      return "書式に問題はありません（サーバーでの確認はできませんでした）";
  }
}

function IssueList({ issues, tone }: { issues: ManifestIssue[]; tone: "danger" | "muted" }) {
  return (
    <ul className="divide-y divide-gray-100 border-t border-gray-100">
      {issues.map((issue, i) => (
        <li key={`${issue.path}-${i}`} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:gap-4">
          <code
            className={cn(
              "shrink-0 break-all font-mono text-xs sm:w-44 sm:pt-0.5",
              tone === "danger" ? "text-red-700" : "text-gray-500",
            )}
          >
            {issue.path || "（全体）"}
          </code>
          <span className="text-sm leading-relaxed text-gray-800">{issue.message}</span>
        </li>
      ))}
    </ul>
  );
}

/** 定義（YAML）の編集欄。入力中に内容をチェックして、問題を項目ごとに表示する */
export function ManifestEditor({
  value,
  onChange,
  onValidationChange,
  label = "エージェントの定義（YAML）",
  hint,
  disabled = false,
  rows = 24,
  expectedKey,
  saveErrors,
}: ManifestEditorProps) {
  const validation = useManifestValidation(value, { expectedKey });
  const escapedRef = useRef(false);

  useEffect(() => {
    onValidationChange?.(validation);
  }, [validation, onValidationChange]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      escapedRef.current = true;
      return;
    }
    const escaped = escapedRef.current;
    escapedRef.current = false;
    if (e.key !== "Tab" || escaped || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const el = e.currentTarget;
    // execCommand なら「元に戻す」が効く。使えないブラウザでは直接書き換える
    const inserted = typeof document.execCommand === "function" && document.execCommand("insertText", false, "  ");
    if (!inserted) {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      onChange(`${value.slice(0, start)}  ${value.slice(end)}`);
      requestAnimationFrame(() => {
        el.selectionStart = start + 2;
        el.selectionEnd = start + 2;
      });
    }
  };

  const view = STATUS_VIEW[validation.status];
  const saveErrorList = Object.entries(saveErrors ?? {}).map(([path, message]) => ({
    path: path === "manifest" ? "" : path,
    message,
  }));

  return (
    <div className="space-y-3">
      <Field
        label={label}
        hint={
          hint ?? (
            <>
              Tab キーで空白 2 つを入力します。編集欄から次の項目へ移るときは、Esc キーを押してから Tab キーを押してください。
            </>
          )
        }
      >
        <Textarea
          mono
          rows={rows}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          autoCapitalize="off"
          autoCorrect="off"
          className="min-h-[16rem] resize-y"
        />
      </Field>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <p className={cn("flex items-center gap-2 px-3 py-2 text-sm font-medium", view.className)} role="status" aria-live="polite">
          {view.icon}
          {statusText(validation)}
        </p>
        {validation.errors.length > 0 ? (
          <div className={cn(validation.status === "checking" && "opacity-60")}>
            <IssueList issues={validation.errors} tone={validation.status === "checking" ? "muted" : "danger"} />
          </div>
        ) : null}
        {validation.status === "unverified" && validation.message ? (
          <p className="border-t border-gray-100 px-3 py-2 text-xs text-gray-500">{validation.message}</p>
        ) : null}
      </div>

      {validation.warnings.length > 0 ? (
        <Alert tone="warning" title="確認をおすすめする点">
          <ul className="list-disc space-y-0.5 pl-4">
            {validation.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {saveErrorList.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-red-200 bg-red-50/40" role="alert">
          <p className="px-3 py-2 text-sm font-medium text-red-800">保存できませんでした。次の点を直してください。</p>
          <IssueList issues={saveErrorList} tone="danger" />
        </div>
      ) : null}
    </div>
  );
}
