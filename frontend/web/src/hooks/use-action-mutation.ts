"use client";

import { useCallback, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast";
import type { ActionError, ActionResult } from "@/lib/utils/action-result";
import { toActionError, unwrapAction } from "./action-client";

export type MutationResult<T> = { ok: true; data: T } | { ok: false; error: ActionError };

export interface ActionMutationOptions<T> {
  /** 成功時に表示するメッセージ */
  successMessage?: string | ((data: T) => string);
  /** 失敗時にトーストを表示するか（既定 true） */
  errorToast?: boolean;
  onSuccess?: (data: T) => void | Promise<void>;
  onError?: (error: ActionError) => void;
}

export interface ActionMutation<Args extends unknown[], T> {
  /** 失敗しても throw しない。結果の ok で分岐する */
  mutate: (...args: Args) => Promise<MutationResult<T>>;
  pending: boolean;
  error: ActionError | null;
  /** 項目ごとの入力エラー（キーは項目のパス。例: "spec.studio_function.url"） */
  fieldErrors: Record<string, string>;
  reset: () => void;
}

/** 作成・更新・削除などの Server Action を呼ぶ */
export function useActionMutation<Args extends unknown[], T>(
  action: (...args: Args) => Promise<ActionResult<T>>,
  options: ActionMutationOptions<T> = {},
): ActionMutation<Args, T> {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const actionRef = useRef(action);
  actionRef.current = action;

  const mutate = useCallback(
    async (...args: Args): Promise<MutationResult<T>> => {
      setPending(true);
      setError(null);
      try {
        const data = await unwrapAction(actionRef.current(...args));
        const { successMessage, onSuccess } = optionsRef.current;
        if (successMessage) toast.success(typeof successMessage === "function" ? successMessage(data) : successMessage);
        await onSuccess?.(data);
        return { ok: true, data };
      } catch (e) {
        const err = toActionError(e);
        setError(err);
        const { errorToast = true, onError } = optionsRef.current;
        if (errorToast && err.code !== "session_expired") toast.error(err.message);
        onError?.(err);
        return { ok: false, error: err };
      } finally {
        setPending(false);
      }
    },
    [toast],
  );

  const reset = useCallback(() => setError(null), []);

  return { mutate, pending, error, fieldErrors: error?.fieldErrors ?? {}, reset };
}
