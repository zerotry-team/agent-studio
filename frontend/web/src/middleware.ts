import { NextResponse, type NextRequest } from "next/server";
import { PATHNAME_HEADER, SESSION_COOKIE, isPublicPath } from "@/lib/auth/constants";
import { chunkName } from "@/lib/auth/cookie-chunks";

/**
 * 公開 URL（APP_BASE_URL）のホスト名。
 * CloudFront → ALB の経路で Host ヘッダが書き換わっても、Server Action の CSRF チェック
 * （Origin と x-forwarded-host の照合）が公開 URL を基準に行われるようにする。
 */
function publicOrigin(): URL | null {
  const raw = process.env.APP_BASE_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * /auth/*、/api/health、/_next/*、静的ファイル以外はセッション Cookie を必須にする。
 * ここでは Cookie の有無だけを見る（復号・トークンの更新はサーバー側の session ヘルパーで行う）。
 */
export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  const headers = new Headers(request.headers);
  const origin = publicOrigin();
  if (origin) headers.set("x-forwarded-host", origin.host);
  headers.set(PATHNAME_HEADER, `${pathname}${search}`);
  const next = () => NextResponse.next({ request: { headers } });

  if (isPublicPath(pathname)) return next();

  const hasSession = request.cookies.has(chunkName(SESSION_COOKIE, 0));
  if (!hasSession) {
    // Server Action は通す（Action 側でセッション切れを返し、画面がログイン画面へ移動する）
    if (request.method === "POST" && request.headers.has("next-action")) return next();

    // プロキシの内側のホスト名を出さないよう、公開 URL があればそれを基準にする
    const loginPath = pathname === "/" ? "/auth/login" : `/auth/login?next=${encodeURIComponent(`${pathname}${search}`)}`;
    return NextResponse.redirect(new URL(loginPath, origin ?? request.url));
  }

  return next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|icon\\.svg|robots\\.txt|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|css|js|map|txt|woff2?)$).*)",
  ],
};
