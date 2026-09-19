import "server-only";
import type { MeDto } from "@agent-studio/contracts";
import { cookies } from "next/headers";
import { ORG_COOKIE } from "@/lib/auth/constants";
import { cookieOptions, getAccessToken } from "@/lib/auth/session";
import { isUuid } from "@/lib/utils/organization";
import { ApiClient } from "./client";
import { getApiBaseUrl } from "./config";

const ORG_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function readOrganizationCookie(): string | null {
  const value = cookies().get(ORG_COOKIE)?.value;
  return isUuid(value) ? value : null;
}

export function writeOrganizationCookie(organizationId: string): void {
  cookies().set(ORG_COOKIE, organizationId, cookieOptions(ORG_COOKIE_MAX_AGE_SECONDS));
}

/**
 * 操作中の組織。Cookie（as_org）が無ければ最初の所属組織を使い、可能なら Cookie に保存する。
 * 所属の確認は API サーバーが必ず行う（ORG-05）。
 */
async function getActiveOrganizationId(): Promise<string | null> {
  const fromCookie = readOrganizationCookie();
  if (fromCookie) return fromCookie;

  const me = await getServerApiClient().get<MeDto>("/me");
  const first = me.memberships[0]?.organization.id ?? null;
  if (first) {
    try {
      writeOrganizationCookie(first);
    } catch {
      // Server Component の描画中は Cookie を書き換えられない
    }
  }
  return first;
}

let client: ApiClient | null = null;

/** サーバー側（Server Action / Server Component / Route Handler）専用の API クライアント */
export function getServerApiClient(): ApiClient {
  client ??= new ApiClient({
    baseUrl: getApiBaseUrl,
    getToken: getAccessToken,
    getOrganizationId: getActiveOrganizationId,
  });
  return client;
}
