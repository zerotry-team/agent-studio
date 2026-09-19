"use client";

import { useCallback, useEffect, useRef, useState, type DependencyList, type Dispatch, type SetStateAction } from "react";
import type { ActionError, ActionResult } from "@/lib/utils/action-result";
import { toActionError, unwrapAction } from "./action-client";

export interface ActionQueryOptions<T> {
  /** false の間は取得しない */
  enabled?: boolean;
  /** 定期的に取り直す間隔（ミリ秒）。関数なら最新のデータから決める（false で停止） */
  refetchInterval?: number | false | ((data: T | undefined) => number | false);
}

export interface ActionQuery<T> {
  data: T | undefined;
  error: ActionError | null;
  /** 最初の取得中 */
  loading: boolean;
  /** 再取得中（データは表示したまま） */
  refreshing: boolean;
  reload: () => Promise<void>;
  setData: Dispatch<SetStateAction<T | undefined>>;
}

/**
 * Server Action でデータを取得する。deps が変わると取り直す。
 * 画面（"use client" のページ）はこのフック経由で Action を呼び、API を直接呼ばない。
 */
export function useActionQuery<T>(
  fetcher: () => Promise<ActionResult<T>>,
  deps: DependencyList,
  options: ActionQueryOptions<T> = {},
): ActionQuery<T> {
  const { enabled = true, refetchInterval } = options;
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ActionError | null>(null);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [refreshing, setRefreshing] = useState(false);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const intervalRef = useRef(refetchInterval);
  intervalRef.current = refetchInterval;
  const dataRef = useRef<T | undefined>(undefined);
  const requestId = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const run = useCallback(async (isInitial: boolean) => {
    const id = ++requestId.current;
    clearTimer();
    if (isInitial) setLoading(true);
    else setRefreshing(true);
    try {
      const value = await unwrapAction(fetcherRef.current());
      if (!mounted.current || id !== requestId.current) return;
      dataRef.current = value;
      setData(value);
      setError(null);
    } catch (e) {
      if (!mounted.current || id !== requestId.current) return;
      setError(toActionError(e));
    } finally {
      if (mounted.current && id === requestId.current) {
        setLoading(false);
        setRefreshing(false);
        const setting = intervalRef.current;
        const interval = typeof setting === "function" ? setting(dataRef.current) : setting;
        if (interval && interval > 0) {
          timer.current = setTimeout(() => {
            void run(false);
          }, interval);
        }
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimer();
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      clearTimer();
      setLoading(false);
      return;
    }
    dataRef.current = undefined;
    setData(undefined);
    setError(null);
    void run(true);
    return clearTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);

  const reload = useCallback(() => run(false), [run]);

  const setDataAndRef: Dispatch<SetStateAction<T | undefined>> = useCallback((action) => {
    setData((prev) => {
      const next = typeof action === "function" ? (action as (p: T | undefined) => T | undefined)(prev) : action;
      dataRef.current = next;
      return next;
    });
  }, []);

  return { data, error, loading, refreshing, reload, setData: setDataAndRef };
}
