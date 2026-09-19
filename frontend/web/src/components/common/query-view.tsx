"use client";

import type { ReactNode } from "react";
import { Alert } from "@/components/ui/alert";
import type { ActionQuery } from "@/hooks/use-action-query";
import { ErrorState } from "./error-state";

export interface QueryViewProps<T> {
  query: ActionQuery<T>;
  /** 最初の読み込み中に表示する（スケルトンなど） */
  loading: ReactNode;
  /** データが空のときに表示する（isEmpty が true のとき） */
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  children: (data: T) => ReactNode;
  compactError?: boolean;
}

/**
 * useActionQuery の結果に応じて「読み込み中 / エラー / 空 / 内容」を出し分ける。
 * 再読み込みに失敗した場合は、表示中の内容を残したまま上に警告を出す。
 */
export function QueryView<T>({ query, loading, empty, isEmpty, children, compactError = false }: QueryViewProps<T>) {
  const { data, error, reload, refreshing } = query;
  if (data === undefined) {
    if (error) return <ErrorState message={error.message} onRetry={reload} retrying={refreshing} compact={compactError} />;
    return <>{loading}</>;
  }
  return (
    <>
      {error ? (
        <Alert tone="warning" className="mb-4" title="最新の情報を読み込めませんでした">
          {error.message}
        </Alert>
      ) : null}
      {empty !== undefined && isEmpty?.(data) ? empty : children(data)}
    </>
  );
}
