import {
  setConnectorOAuthAppSchema,
  type ConnectionDto,
  type ConnectorOAuthAppDto,
  type ConnectorOAuthExchangeInput,
  type ConnectorOAuthStartDto,
  type ConnectorOAuthStartInput,
  type SetConnectorOAuthAppInput,
} from "@agent-studio/contracts";
import { notFound, preconditionFailed, validationError } from "../domain/errors.js";
import { catalogEntryFor, minimalScopes, readPath, type CatalogOAuth2, type ProviderCatalogEntry } from "../domain/provider-catalog.js";
import { recordAudit } from "../infrastructure/audit.js";
import { secretNames } from "../infrastructure/secrets/secret-store.js";
import { auditBy, requireRole, scopeOf, type MemberActor } from "./context.js";
import type { Deps } from "./deps.js";
import { toConnectionDto } from "./dto.js";

const USER_AGENT = "agent-studio-connector-oauth";
const REQUEST_TIMEOUT_MS = 15_000;

function usableEnvSecret(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "unset" ? trimmed : null;
}

/**
 * Provider Catalog に定義した OAuth2 を、Connector の種類を問わず同じ手順で扱う。
 * - Client Secret / access token は Secret Store だけに保存し、DB・ログ・レスポンスへ出さない
 * - state と PKCE verifier はフロントの封印 cookie が持ち、API は保持しない
 */
export class ConnectorOAuthService {
  constructor(private readonly deps: Deps) {}

  private async loadConnector(actor: MemberActor, connectorId: string) {
    const connector = await this.deps.db.run(scopeOf(actor), (tx) =>
      tx.connectors.findFirst({
        where: { id: connectorId, organization_id: actor.organizationId },
        include: { tools: { select: { name: true } } },
      }),
    );
    if (!connector) throw notFound("連携サービス");
    const entry = catalogEntryFor(connector);
    if (!entry || entry.auth.kind !== "oauth2") throw validationError("この連携サービスはOAuth接続に対応していません");
    return { connector, entry, oauth: entry.auth };
  }

  private envCredentials(entry: ProviderCatalogEntry): { clientId: string | null; clientSecret: string | null } {
    const fromEnv = this.deps.env.PROVIDER_OAUTH[entry.key] ?? {};
    return { clientId: usableEnvSecret(fromEnv.client_id), clientSecret: usableEnvSecret(fromEnv.client_secret) };
  }

  /** OAuth application の準備状況。Client Secret は存在の有無だけを返す。 */
  async getApp(actor: MemberActor, connectorId: string): Promise<ConnectorOAuthAppDto> {
    const { connector, entry } = await this.loadConnector(actor, connectorId);
    const env = this.envCredentials(entry);
    const clientId = connector.oauth_client_id ?? env.clientId;
    const hasClientSecret = Boolean(connector.oauth_client_secret_locator || env.clientSecret);
    return { connector_id: connector.id, provider: entry.key, configured: Boolean(clientId && hasClientSecret), client_id: clientId ?? null, has_client_secret: hasClientSecret };
  }

  /** OAuth application を運営者が一度だけ登録する。Secret 本体は Secret Store 以外へ保存しない。 */
  async setApp(actor: MemberActor, connectorId: string, raw: SetConnectorOAuthAppInput): Promise<ConnectorOAuthAppDto> {
    requireRole(actor, "owner");
    const input = setConnectorOAuthAppSchema.parse(raw);
    const { connector, entry } = await this.loadConnector(actor, connectorId);
    const locator = await this.deps.secrets.put(
      secretNames.connectorOAuthApp(this.deps.env.SECRETS_PREFIX, actor.organizationId, connector.id),
      input.client_secret,
      { "agentstudio:organization_id": actor.organizationId, "agentstudio:connector_id": connector.id },
    );
    await this.deps.db.run(scopeOf(actor), async (tx) => {
      await tx.connectors.update({ where: { id: connector.id }, data: { oauth_client_id: input.client_id, oauth_client_secret_locator: locator } });
      await recordAudit(tx, auditBy(actor, {
        action: "connector.oauth_app.update",
        targetType: "connector",
        targetId: connector.id,
        detail: { provider: entry.key, client_id_updated: true, client_secret_updated: true },
      }));
    });
    return { connector_id: connector.id, provider: entry.key, configured: true, client_id: input.client_id, has_client_secret: true };
  }

  private assertRedirectUri(redirectUri: string): void {
    let allowed: URL;
    let requested: URL;
    try {
      allowed = new URL(this.deps.env.PUBLIC_BASE_URL);
      requested = new URL(redirectUri);
    } catch {
      throw validationError("OAuthの戻り先URLが正しくありません");
    }
    // CLI（agent-studio connect）はローカルの待ち受けへ戻す。Provider 側の OAuth アプリにも同じ URI を登録しておく
    const loopback = ["127.0.0.1", "localhost"].includes(requested.hostname) && requested.pathname === "/callback";
    if (requested.origin !== allowed.origin && !loopback) throw validationError("OAuthの戻り先はAgent Studioの画面かCLIのローカル待ち受けだけに設定できます");
  }

  /** 認可 URL を組み立てる。scope は Connector に登録済みの操作に必要な最小集合。 */
  async start(actor: MemberActor, connectorId: string, input: ConnectorOAuthStartInput): Promise<ConnectorOAuthStartDto> {
    requireRole(actor, "builder");
    this.assertRedirectUri(input.redirect_uri);
    const { connector, entry, oauth } = await this.loadConnector(actor, connectorId);
    const clientId = connector.oauth_client_id ?? this.envCredentials(entry).clientId;
    if (!clientId) throw preconditionFailed(`${entry.name}のOAuthアプリがまだAgent Studioに設定されていません`);
    const scopes = minimalScopes(entry, connector.tools.map((tool) => tool.name));
    const url = new URL(oauth.authorize_url);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", input.redirect_uri);
    url.searchParams.set("state", input.state);
    url.searchParams.set("response_type", "code");
    if (scopes.length) url.searchParams.set("scope", scopes.join(oauth.scope_separator));
    if (oauth.pkce) {
      if (!input.code_challenge) throw validationError("この連携サービスはPKCEが必要です");
      url.searchParams.set("code_challenge", input.code_challenge);
      url.searchParams.set("code_challenge_method", "S256");
    }
    for (const [key, value] of Object.entries(oauth.extra_authorize_params ?? {})) url.searchParams.set(key, value);
    return { authorize_url: url.toString(), scopes };
  }

  private async requestToken(oauth: CatalogOAuth2, credentials: { clientId: string; clientSecret: string }, input: ConnectorOAuthExchangeInput): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": USER_AGENT };
    let body: string;
    if (oauth.token_request === "json") {
      headers["content-type"] = "application/json";
      body = JSON.stringify({ client_id: credentials.clientId, client_secret: credentials.clientSecret, code: input.code });
    } else {
      headers["content-type"] = "application/x-www-form-urlencoded";
      const form = new URLSearchParams({ grant_type: "authorization_code", code: input.code, redirect_uri: input.redirect_uri });
      if (input.code_verifier) form.set("code_verifier", input.code_verifier);
      if (oauth.token_auth === "basic") {
        headers.authorization = `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64")}`;
      } else {
        form.set("client_id", credentials.clientId);
        form.set("client_secret", credentials.clientSecret);
      }
      body = form.toString();
    }
    const response = await fetch(oauth.token_url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !parsed || parsed.ok === false || typeof readPath(parsed, oauth.access_token_path) !== "string") {
      throw preconditionFailed(`認証を完了できませんでした（HTTP ${response.status}）`);
    }
    return parsed;
  }

  /** 認可コードを token へ交換し、Agent Studio の Connection として保存する。 */
  async exchange(actor: MemberActor, connectorId: string, input: ConnectorOAuthExchangeInput): Promise<ConnectionDto> {
    requireRole(actor, "builder");
    this.assertRedirectUri(input.redirect_uri);
    const { connector, entry, oauth } = await this.loadConnector(actor, connectorId);
    const env = this.envCredentials(entry);
    const clientId = connector.oauth_client_id ?? env.clientId;
    const storedSecret = connector.oauth_client_secret_locator ? await this.deps.secrets.get(connector.oauth_client_secret_locator) : null;
    const clientSecret = storedSecret ?? env.clientSecret;
    if (!clientId || !clientSecret) throw preconditionFailed(`${entry.name}のOAuthアプリがまだAgent Studioに設定されていません`);

    const token = await this.requestToken(oauth, { clientId, clientSecret }, input);
    const accessToken = readPath(token, oauth.access_token_path) as string;
    const grantedScopes = Array.isArray(token.scopes)
      ? token.scopes.filter((scope): scope is string => typeof scope === "string")
      : typeof token.scope === "string" ? token.scope.split(/[\s,]+/).filter(Boolean) : null;
    const required = minimalScopes(entry, connector.tools.map((tool) => tool.name));
    if (grantedScopes) {
      const missing = required.filter((scope) => !grantedScopes.includes(scope));
      if (missing.length) throw preconditionFailed(`${entry.name}で必要な権限（${missing.join("、")}）が許可されていません`);
    }
    const expiresAt = typeof token.expires_in === "number" && token.expires_in > 0 ? new Date(Date.now() + token.expires_in * 1000) : null;

    let identityId = "account";
    let identityLabel: string | null = null;
    if (oauth.identity) {
      const me = await fetch(oauth.identity.url, {
        headers: { accept: "application/json", authorization: `Bearer ${accessToken}`, "user-agent": USER_AGENT },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const user = (await me.json().catch(() => null)) as unknown;
      const id = readPath(user, oauth.identity.id_path);
      if (!me.ok || (typeof id !== "string" && typeof id !== "number") || !String(id).trim()) {
        throw preconditionFailed(`${entry.name}のアカウントを確認できませんでした`);
      }
      identityId = String(id).trim();
      const label = oauth.identity.label_path ? readPath(user, oauth.identity.label_path) : null;
      identityLabel = typeof label === "string" && label.trim() ? label.trim() : null;
    }
    const description = `${entry.key}-user:${identityId}`;
    const baseName = `${entry.name} (${identityLabel ?? identityId})`;

    const connection = await this.deps.db.run(scopeOf(actor), async (tx) => {
      const existing = await tx.connections.findFirst({ where: { organization_id: actor.organizationId, connector_id: connector.id, description } });
      if (existing) return existing;
      // Builder が事前作成した「認証情報待ち」の Connection があれば、その枠を使う（一覧に空の接続を残さない）
      const managed = await tx.connections.findFirst({
        where: { organization_id: actor.organizationId, connector_id: connector.id, secret_locator: null, revoked_at: null, metadata: { path: ["managed_by"], equals: "builder" } },
        orderBy: { created_at: "asc" },
      });
      const nameTaken = await tx.connections.findFirst({ where: { organization_id: actor.organizationId, name: baseName, NOT: managed ? { id: managed.id } : undefined }, select: { id: true } });
      const name = nameTaken ? `${baseName} ${Date.now().toString(36).slice(-4)}` : baseName;
      if (managed) return tx.connections.update({ where: { id: managed.id }, data: { name, description } });
      return tx.connections.create({
        data: { organization_id: actor.organizationId, connector_id: connector.id, name, description, scope: "studio", header_name: oauth.header_name },
      });
    });
    const locator = await this.deps.secrets.put(
      secretNames.connection(this.deps.env.SECRETS_PREFIX, actor.organizationId, connection.id),
      accessToken,
      { "agentstudio:organization_id": actor.organizationId },
    );
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const updated = await tx.connections.update({
        where: { id: connection.id },
        data: { secret_locator: locator, status: "connected", last_validated_at: new Date(), expires_at: expiresAt, revoked_at: null },
      });
      await recordAudit(tx, auditBy(actor, {
        action: "connection.oauth.connected",
        targetType: "connection",
        targetId: connection.id,
        detail: { connector_id: connector.id, provider: entry.key, account: identityId, scopes: grantedScopes ?? required },
      }));
      return toConnectionDto(updated);
    });
  }
}
