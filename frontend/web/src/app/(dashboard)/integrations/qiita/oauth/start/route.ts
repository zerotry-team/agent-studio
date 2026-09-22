import type { NextRequest } from "next/server";
import { redirectTo } from "@/lib/auth/responses";

export const dynamic = "force-dynamic";

/** 旧URL。Provider共通の /integrations/oauth/start へ転送する */
export async function GET(request: NextRequest) {
  const params = new URLSearchParams(request.nextUrl.searchParams);
  return redirectTo(`/integrations/oauth/start?${params.toString()}`);
}
