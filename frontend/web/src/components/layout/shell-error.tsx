"use client";

import { CircleAlert, RefreshCw } from "lucide-react";
import { Button, buttonClassName } from "@/components/ui/button";
import { Logo } from "./logo";

/** ユーザー情報を読み込めなかったとき（API が止まっている、アカウントが未登録など）の全画面表示 */
export function ShellError({ title, message, showRetry = true }: { title: string; message: string; showRetry?: boolean }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4 py-12">
      <div className="mb-8">
        <Logo />
      </div>
      <div role="alert" className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-red-50 text-red-500" aria-hidden="true">
          <CircleAlert className="h-5 w-5" />
        </div>
        <h1 className="text-base font-semibold text-gray-900">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-gray-500">{message}</p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          {showRetry ? (
            <Button onClick={() => window.location.reload()} icon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}>
              もう一度読み込む
            </Button>
          ) : null}
          <a href="/auth/logout" className={buttonClassName("secondary")}>
            ログアウト
          </a>
        </div>
      </div>
    </div>
  );
}
