import type { Metadata } from "next";
import { CircleAlert } from "lucide-react";
import { Card, CardBody } from "@/components/ui/card";
import { buttonClassName } from "@/components/ui/button";

export const metadata: Metadata = { title: "ログインできませんでした" };

const MESSAGES: Record<string, { title: string; body: string }> = {
  state: {
    title: "ログインの手続きをやり直してください",
    body: "ログインの途中で時間がたったか、別のタブで操作された可能性があります。もう一度ログインしてください。",
  },
  token: {
    title: "ログインを完了できませんでした",
    body: "認証サーバーとのやり取りに失敗しました。時間をおいて、もう一度お試しください。",
  },
  denied: {
    title: "ログインが中断されました",
    body: "ログインがキャンセルされたか、認証サーバーで拒否されました。もう一度お試しください。",
  },
  config: {
    title: "現在ログインできません",
    body: "サーバーの設定に誤りがあるため、ログインできません。管理者に連絡してください。",
  },
};

export default function AuthErrorPage({ searchParams }: { searchParams: { reason?: string } }) {
  const message = MESSAGES[searchParams.reason ?? ""] ?? MESSAGES.token!;
  return (
    <Card>
      <CardBody className="space-y-5 text-center">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-red-50 text-red-500" aria-hidden="true">
          <CircleAlert className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-base font-semibold text-gray-900">{message.title}</h1>
          <p className="mt-2 text-sm leading-relaxed text-gray-500">{message.body}</p>
        </div>
        {/* ログインは画面遷移（Cognito へのリダイレクト）なので通常のリンクにする */}
        <a href="/auth/login" className={buttonClassName("primary", "md", "w-full")}>
          もう一度ログインする
        </a>
      </CardBody>
    </Card>
  );
}
