"use client";

import { TERMINAL_RUN_STATUSES, type RunDto, type RunEventDto, type RunStatus } from "@agent-studio/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { getRunEventsAction } from "@/actions/runs";
import { toActionError, unwrapAction } from "@/hooks/action-client";
import type { ActionError } from "@/lib/utils/action-result";

/** 経過を取り直す間隔 */
const POLL_INTERVAL_MS = 2_000;
/** 一時的に取得できなかったときに、もう一度試すまでの間隔 */
const RETRY_INTERVAL_MS = 5_000;
/** 追加の指示や承認のあと、終了済みに見えても取り続ける時間（サーバー側の状態の反映待ち） */
const RESUME_GRACE_MS = 10_000;

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/** seq で重複を除いて、古い順に並べる */
function mergeEvents(current: RunEventDto[], incoming: RunEventDto[]): RunEventDto[] {
  if (incoming.length === 0) return current;
  const lastSeq = current.length > 0 ? (current[current.length - 1]?.seq ?? 0) : 0;
  const sortedIncoming = [...incoming].sort((a, b) => a.seq - b.seq);
  if ((sortedIncoming[0]?.seq ?? 0) > lastSeq) return [...current, ...sortedIncoming];
  const bySeq = new Map<number, RunEventDto>();
  for (const e of current) bySeq.set(e.seq, e);
  for (const e of sortedIncoming) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export interface RunStream {
  run: RunDto | undefined;
  events: RunEventDto[];
  /** 最初の読み込みに失敗した */
  error: ActionError | null;
  /** 読み込み後の更新に一時的に失敗した（表示中の内容は残す） */
  pollError: string | null;
  /** 最初の読み込み中 */
  loading: boolean;
  /** 自動で更新している */
  polling: boolean;
  /** 最初から読み込み直す */
  reload: () => void;
  /** すぐに取り直し、終了するまで自動の更新を続ける（追加の指示・承認のあとに呼ぶ） */
  resume: () => void;
  /** 中止した結果など、手元にある最新の状態で置き換える */
  setRun: (run: RunDto) => void;
}

/**
 * 実行の状態と経過（イベント）を 2 秒ごとに取得する。
 * 前回までに受け取った seq より後のイベントだけを取り、終了（完了・失敗・中止）したら止める。
 */
export function useRunStream(runId: string): RunStream {
  const [run, setRunState] = useState<RunDto | undefined>(undefined);
  const [events, setEvents] = useState<RunEventDto[]>([]);
  const [error, setError] = useState<ActionError | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [polling, setPolling] = useState(false);

  const lastSeq = useRef(0);
  const hasRun = useRef(false);
  const graceUntil = useRef(0);
  const loopId = useRef(0);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  /** 進行中の取得ループを無効にする（結果が返ってきても使わない） */
  const invalidate = useCallback(() => {
    loopId.current += 1;
    clearTimer();
  }, [clearTimer]);

  const tick = useCallback(
    async (id: number): Promise<void> => {
      timer.current = null;
      let next: number | null = POLL_INTERVAL_MS;
      try {
        const res = await unwrapAction(getRunEventsAction(runId, lastSeq.current));
        if (!mounted.current || id !== loopId.current) return;
        if (res.events.length > 0) {
          lastSeq.current = res.events.reduce((max, e) => Math.max(max, e.seq), lastSeq.current);
          setEvents((prev) => mergeEvents(prev, res.events));
        }
        hasRun.current = true;
        setRunState(res.run);
        setError(null);
        setPollError(null);
        if (isTerminalRunStatus(res.run.status) && Date.now() >= graceUntil.current) next = null;
      } catch (e) {
        if (!mounted.current || id !== loopId.current) return;
        const err = toActionError(e);
        if (!hasRun.current) {
          setError(err);
          next = null;
        } else if (err.code === "not_found" || err.code === "forbidden") {
          setPollError(err.message);
          next = null;
        } else {
          setPollError(err.message);
          next = RETRY_INTERVAL_MS;
        }
      }
      setLoading(false);
      setPolling(next !== null);
      if (next !== null) {
        timer.current = setTimeout(() => {
          void tick(id);
        }, next);
      }
    },
    [runId],
  );

  const start = useCallback(() => {
    invalidate();
    const id = loopId.current;
    setPolling(true);
    void tick(id);
  }, [invalidate, tick]);

  useEffect(() => {
    mounted.current = true;
    lastSeq.current = 0;
    hasRun.current = false;
    graceUntil.current = 0;
    setRunState(undefined);
    setEvents([]);
    setError(null);
    setPollError(null);
    setLoading(true);
    start();
    return () => {
      mounted.current = false;
      invalidate();
    };
  }, [start, invalidate]);

  const reload = useCallback(() => {
    if (!hasRun.current) setLoading(true);
    start();
  }, [start]);

  const resume = useCallback(() => {
    graceUntil.current = Date.now() + RESUME_GRACE_MS;
    start();
  }, [start]);

  const setRun = useCallback((next: RunDto) => {
    hasRun.current = true;
    setRunState(next);
  }, []);

  return { run, events, error, pollError, loading, polling, reload, resume, setRun };
}
