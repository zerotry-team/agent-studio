import type { Metadata } from "next";
import { Alert } from "@/components/ui/alert";
import { Card, CardBody } from "@/components/ui/card";
import { getAuthMode } from "@/lib/auth/config";
import { sanitizeReturnTo } from "@/lib/auth/pkce";
import { DevLoginForm } from "./dev-login-form";

export const metadata: Metadata = { title: "ログイン（開発用）" };
export const dynamic = "force-dynamic";

function isDevMode(): boolean {
  try {
    return getAuthMode() === "dev";
  } catch {
    return false;
  }
}

export default function DevLoginPage({ searchParams }: { searchParams: { next?: string } }) {
  const next = sanitizeReturnTo(searchParams.next);
  if (!isDevMode()) {
    return (
      <Alert tone="warning" title="開発用ログインは使えません">
        この環境では通常のログインを使ってください。{" "}
        <a href="/auth/login" className="font-medium underline">
          ログイン画面へ
        </a>
      </Alert>
    );
  }
  return (
    <Card>
      <CardBody className="space-y-5">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">ログイン（開発用）</h1>
          <p className="mt-1 text-sm leading-relaxed text-gray-500">
            ローカル開発専用のログインです。入力したメールアドレスのユーザーとして API を呼び出します。
          </p>
        </div>
        <DevLoginForm next={next} />
      </CardBody>
    </Card>
  );
}
