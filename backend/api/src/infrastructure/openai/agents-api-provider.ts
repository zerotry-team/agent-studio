import OpenAI from "openai";
import type { Env } from "../../env.js";
import { preconditionFailed } from "../../domain/errors.js";
import type { TenantDb } from "../db/tenant-db.js";
import type { SecretStore } from "../secrets/secret-store.js";
import { OpenAiAgentsApi, type AgentsApi } from "./agents-api.js";
import { FakeAgentsApi } from "./fake-agents-api.js";

const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * 組織ごとの OpenAI クライアント（SEC-11: 企業ごとに OpenAI Project とアプリキーを分ける）。
 * キーは Secrets Manager から読み、5分だけメモリに保持する（ローテーションを反映するため）。
 */
export class AgentsApiProvider {
  private readonly cache = new Map<string, { api: AgentsApi; expiresAt: number }>();
  private readonly fake: FakeAgentsApi | null;

  constructor(
    private readonly env: Env,
    private readonly db: TenantDb,
    private readonly secrets: SecretStore,
  ) {
    this.fake = env.AGENTS_API_MODE === "fake" ? new FakeAgentsApi() : null;
  }

  async forOrganization(organizationId: string): Promise<AgentsApi> {
    if (this.fake) return this.fake;

    const cached = this.cache.get(organizationId);
    if (cached && cached.expiresAt > Date.now()) return cached.api;

    const settings = await this.db.org(organizationId, (tx) =>
      tx.organization_openai_settings.findUnique({ where: { organization_id: organizationId } }),
    );
    let apiKey = settings?.app_key_secret_arn ? await this.secrets.get(settings.app_key_secret_arn) : null;
    if (!apiKey && this.env.NODE_ENV !== "production" && this.env.OPENAI_API_KEY) {
      apiKey = this.env.OPENAI_API_KEY;
    }
    if (!apiKey) {
      throw preconditionFailed("OpenAI のアプリキーが設定されていません。設定 > OpenAI から登録してください");
    }

    const api = new OpenAiAgentsApi(
      new OpenAI({ apiKey, project: settings?.openai_project_id ?? undefined, maxRetries: 2 }),
    );
    this.cache.set(organizationId, { api, expiresAt: Date.now() + CACHE_TTL_MS });
    return api;
  }

  /** キーを変更したときに呼ぶ */
  invalidate(organizationId: string): void {
    this.cache.delete(organizationId);
  }
}
