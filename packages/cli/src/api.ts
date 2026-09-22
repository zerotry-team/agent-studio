import type { CliConfig } from "./config.js";
import { saveConfig } from "./config.js";

export class CliError extends Error {}

type AuthConfig = { mode: "dev" | "cognito"; cognito: { domain: string; cli_client_id: string } | null };

/** Agent Studio API の薄いクライアント。組織ヘッダとトークンを付け、エラーは日本語メッセージのまま返す。 */
export class ApiClient {
  constructor(private config: CliConfig) {}

  get baseUrl(): string {
    return this.config.api_url.replace(/\/+$/, "");
  }

  /** API のオリジン（Webhook URL などに使う） */
  get origin(): string {
    return new URL(this.baseUrl).origin;
  }

  async authConfig(): Promise<AuthConfig> {
    const response = await fetch(`${this.baseUrl}/auth/config`);
    if (!response.ok) throw new CliError(`API に接続できませんでした（${this.baseUrl}, HTTP ${response.status}）。--api で URL を指定してください`);
    return (await response.json()) as AuthConfig;
  }

  private async ensureToken(): Promise<string> {
    if (!this.config.token) throw new CliError("ログインしていません。先に `agent-studio login` を実行してください");
    const expiresAt = this.config.token_expires_at ? Date.parse(this.config.token_expires_at) : Number.POSITIVE_INFINITY;
    if (Date.now() < expiresAt - 60_000 || !this.config.refresh_token) return this.config.token;
    const auth = await this.authConfig();
    if (!auth.cognito) return this.config.token;
    const response = await fetch(`${auth.cognito.domain}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: auth.cognito.cli_client_id, refresh_token: this.config.refresh_token }).toString(),
    });
    const body = (await response.json().catch(() => null)) as { id_token?: string; expires_in?: number } | null;
    if (!response.ok || !body?.id_token) throw new CliError("ログインの有効期限が切れました。`agent-studio login` をやり直してください");
    this.config = { ...this.config, token: body.id_token, token_expires_at: new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString() };
    saveConfig(this.config);
    return body.id_token;
  }

  async request<T>(method: string, path: string, body?: unknown, options: { org?: boolean } = {}): Promise<T> {
    const token = await this.ensureToken();
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (options.org !== false) {
      if (!this.config.organization_id) throw new CliError("組織が選ばれていません。`agent-studio orgs` で確認し `agent-studio use <slug>` で選んでください");
      headers["x-organization-id"] = this.config.organization_id;
    }
    const response = await fetch(`${this.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as unknown) : null;
    if (!response.ok) {
      const message = (parsed as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${response.status}`;
      throw new CliError(message);
    }
    return parsed as T;
  }

  get<T>(path: string, options?: { org?: boolean }): Promise<T> {
    return this.request<T>("GET", path, undefined, options);
  }

  post<T>(path: string, body: unknown = {}, options?: { org?: boolean }): Promise<T> {
    return this.request<T>("POST", path, body, options);
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }
}
