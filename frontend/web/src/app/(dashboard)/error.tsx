"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/common/error-state";

/** 画面の描画中に想定外のエラーが起きたとき */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return <ErrorState message="画面を表示できませんでした。もう一度お試しください。問題が続く場合は管理者に連絡してください。" onRetry={reset} />;
}
