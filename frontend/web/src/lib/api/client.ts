import { ORGANIZATION_HEADER } from "@agent-studio/contracts";
import { ApiError, toApiError, unavailableError } from "./errors";

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** 既定 30 秒。生成 AI を呼ぶ API などは長めにする */
  timeoutMs?: number;
}

export interface ApiClientOptions {
  /** 例: http://api:3200（末尾の /api/v1 は含めない） */
  baseUrl: string | (() => string);
  getToken: () => Promise<string>;
  getOrganizationId: () => Promise<string | null>;
  fetch?: typeof fetch;
}

export const API_PREFIX = "/api/v1";
const DEFAULT_TIMEOUT_MS = 30_000;

/** `x-organization-id` を付けない API（/me と運営管理者用の /admin/*） */
export function requiresOrganizationHeader(path: string): boolean {
  const pathname = path.split("?")[0] ?? path;
  return !(pathname === "/me" || pathname === "/admin" || pathname.startsWith("/admin/"));
}

export function buildQueryString(query?: Record<string, QueryValue>): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

/**
 * Agent Studio API を呼ぶ唯一のクライアント。
 * - Bearer トークンと x-organization-id を付ける
 * - エラー応答（ApiErrorBody）を ApiError（日本語メッセージ）に変換する
 */
export class ApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  private baseUrl(): string {
    const raw = typeof this.options.baseUrl === "function" ? this.options.baseUrl() : this.options.baseUrl;
    return raw.replace(/\/+$/, "");
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    headers.authorization = `Bearer ${await this.options.getToken()}`;

    if (requiresOrganizationHeader(path)) {
      const organizationId = await this.options.getOrganizationId();
      if (!organizationId) {
        throw new ApiError("操作する組織が選ばれていません。組織を選んでから、もう一度お試しください", 0, "no_organization");
      }
      headers[ORGANIZATION_HEADER] = organizationId;
    }

    let body: string | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    const url = `${this.baseUrl()}${API_PREFIX}${path}${buildQueryString(options.query)}`;
    const fetchImpl = this.options.fetch ?? fetch;

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body,
        cache: "no-store",
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (e) {
      throw unavailableError(e);
    }

    if (res.status === 204 || res.status === 202 || res.status === 205) {
      return undefined as T;
    }

    const text = await res.text().catch(() => "");
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (!res.ok) throw toApiError(res.status, parsed);
    return parsed as T;
  }

  get<T>(path: string, query?: Record<string, QueryValue>, options?: Omit<RequestOptions, "query" | "body">): Promise<T> {
    return this.request<T>("GET", path, { ...options, query });
  }

  post<T>(path: string, body?: unknown, options?: Omit<RequestOptions, "body">): Promise<T> {
    return this.request<T>("POST", path, { ...options, body });
  }

  put<T>(path: string, body?: unknown, options?: Omit<RequestOptions, "body">): Promise<T> {
    return this.request<T>("PUT", path, { ...options, body });
  }

  patch<T>(path: string, body?: unknown, options?: Omit<RequestOptions, "body">): Promise<T> {
    return this.request<T>("PATCH", path, { ...options, body });
  }

  delete<T = void>(path: string, options?: Omit<RequestOptions, "body">): Promise<T> {
    return this.request<T>("DELETE", path, options);
  }
}
