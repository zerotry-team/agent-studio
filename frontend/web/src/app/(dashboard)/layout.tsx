import type { MeDto } from "@agent-studio/contracts";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { ActiveOrganizationSync } from "@/components/layout/active-organization-sync";
import { AppShell } from "@/components/layout/app-shell";
import { SessionProvider } from "@/components/layout/session-provider";
import { ShellError } from "@/components/layout/shell-error";
import { ApiError } from "@/lib/api/errors";
import { readOrganizationCookie } from "@/lib/api/server-client";
import { AuthConfigError } from "@/lib/auth/config";
import { PATHNAME_HEADER } from "@/lib/auth/constants";
import { sanitizeReturnTo } from "@/lib/auth/pkce";
import { SessionExpiredError } from "@/lib/auth/session";
import { GetCurrentUserService } from "@/lib/services/me";
import { resolveActiveMembership } from "@/lib/utils/organization";

export const dynamic = "force-dynamic";

type LoadResult =
  | { kind: "ok"; me: MeDto }
  | { kind: "login" }
  | { kind: "error"; title: string; message: string; retry: boolean };

async function loadCurrentUser(): Promise<LoadResult> {
  try {
    return { kind: "ok", me: await new GetCurrentUserService().invoke() };
  } catch (e) {
    if (e instanceof SessionExpiredError) return { kind: "login" };
    if (e instanceof AuthConfigError) {
      console.error("[config]", e.message);
      return { kind: "error", title: "現在ご利用いただけません", message: "サーバーの設定に誤りがあります。管理者に連絡してください。", retry: false };
    }
    if (e instanceof ApiError && (e.code === "unauthorized" || e.code === "forbidden")) {
      // ログイン画面へ戻すと Cognito との間で往復し続けるため、ここで止める
      return { kind: "error", title: "このアカウントでは利用できません", message: e.message, retry: false };
    }
    const message = e instanceof ApiError ? e.message : "ユーザー情報を読み込めませんでした。時間をおいて、もう一度お試しください。";
    if (!(e instanceof ApiError)) console.error("[layout]", e);
    return { kind: "error", title: "読み込めませんでした", message, retry: true };
  }
}

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const result = await loadCurrentUser();

  if (result.kind === "login") {
    const next = sanitizeReturnTo(headers().get(PATHNAME_HEADER));
    redirect(next === "/" ? "/auth/login" : `/auth/login?next=${encodeURIComponent(next)}`);
  }
  if (result.kind === "error") {
    return <ShellError title={result.title} message={result.message} showRetry={result.retry} />;
  }

  const cookieOrganizationId = readOrganizationCookie();
  const active = resolveActiveMembership(result.me.memberships, cookieOrganizationId);
  const activeId = active?.organization.id ?? null;

  return (
    <SessionProvider me={result.me} activeOrganizationId={activeId}>
      {activeId && activeId !== cookieOrganizationId ? <ActiveOrganizationSync organizationId={activeId} /> : null}
      <AppShell>{children}</AppShell>
    </SessionProvider>
  );
}
