import type {
  BootstrapTokenDto,
  BuilderProjectDto,
  ConnectionDto,
  ConnectorDto,
  HumanActionDto,
  MeDto,
  ProviderCatalogEntryDto,
  RuntimeDto,
  RuntimeProfileDto,
} from "@agent-studio/contracts";
import { ApiClient, CliError } from "./api.js";
import { CALLBACK_URL, openBrowser, pkceChallenge, randomUrlSafe, waitForCallback } from "./browser.js";
import { loadConfig, saveConfig, type CliConfig } from "./config.js";
import { flagString, prompt, readSecret, requireFlag, type parseArgs } from "./input.js";

type Flags = ReturnType<typeof parseArgs>["flags"];

const stageShort = (stage: string) => (stage === "production" ? "prod" : "stg");

// ---------------------------------------------------------------------------
// login / orgs
// ---------------------------------------------------------------------------

export async function login(flags: Flags): Promise<void> {
  const config: CliConfig = { ...loadConfig(), api_url: flagString(flags, "api") ?? process.env.AGENT_STUDIO_API_URL ?? loadConfig().api_url };
  const api = new ApiClient(config);
  const auth = await api.authConfig();
  const devEmail = flagString(flags, "dev");
  const token = flagString(flags, "token");
  let next: CliConfig;
  if (devEmail) {
    if (auth.mode !== "dev") throw new CliError("この API は開発用ログインを受け付けていません（本番は `agent-studio login` でブラウザログイン）");
    next = { ...config, token: `dev:${devEmail}`, refresh_token: undefined, token_expires_at: undefined };
  } else if (token) {
    next = { ...config, token, refresh_token: undefined, token_expires_at: undefined };
  } else if (auth.mode === "dev") {
    const email = await prompt("開発用ログインのメールアドレス: ");
    next = { ...config, token: `dev:${email}`, refresh_token: undefined, token_expires_at: undefined };
  } else {
    if (!auth.cognito) throw new CliError("この環境では CLI のブラウザログインが有効になっていません。管理者に COGNITO_DOMAIN / COGNITO_CLI_CLIENT_ID の設定を依頼するか、`--token` で ID トークンを渡してください");
    const verifier = randomUrlSafe();
    const state = randomUrlSafe(16);
    const url = new URL(`${auth.cognito.domain}/oauth2/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", auth.cognito.cli_client_id);
    url.searchParams.set("redirect_uri", CALLBACK_URL);
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", pkceChallenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    const waiting = waitForCallback(["/callback"]);
    openBrowser(url.toString());
    const { query } = await waiting;
    if (query.get("state") !== state || !query.get("code")) throw new CliError("ログインの戻りを検証できませんでした。もう一度お試しください");
    const response = await fetch(`${auth.cognito.domain}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: auth.cognito.cli_client_id, code: query.get("code")!, redirect_uri: CALLBACK_URL, code_verifier: verifier }).toString(),
    });
    const body = (await response.json().catch(() => null)) as { id_token?: string; refresh_token?: string; expires_in?: number } | null;
    if (!response.ok || !body?.id_token) throw new CliError(`ログインを完了できませんでした（HTTP ${response.status}）`);
    next = { ...config, token: body.id_token, refresh_token: body.refresh_token, token_expires_at: new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString() };
  }
  saveConfig(next);
  const me = await new ApiClient(next).get<MeDto>("/me", { org: false });
  console.log(`ログインしました: ${me.user.email}`);
  if (me.memberships.length === 1 && !next.organization_id) {
    const membership = me.memberships[0]!;
    saveConfig({ ...next, organization_id: membership.organization.id, organization_slug: membership.organization.slug });
    console.log(`組織を選びました: ${membership.organization.name}（${membership.organization.slug}）`);
  } else if (!next.organization_id) {
    console.log("`agent-studio orgs` で組織を確認し、`agent-studio use <slug>` で選んでください");
  }
}

export async function orgs(): Promise<void> {
  const config = loadConfig();
  const me = await new ApiClient(config).get<MeDto>("/me", { org: false });
  for (const membership of me.memberships) {
    const current = membership.organization.id === config.organization_id ? "*" : " ";
    console.log(`${current} ${membership.organization.slug.padEnd(24)} ${membership.organization.name}（${membership.role}）`);
  }
}

export async function use(slug: string | undefined): Promise<void> {
  if (!slug) throw new CliError("組織の slug を指定してください（例: agent-studio use sample-a-company）");
  const config = loadConfig();
  const me = await new ApiClient(config).get<MeDto>("/me", { org: false });
  const membership = me.memberships.find((item) => item.organization.slug === slug || item.organization.id === slug);
  if (!membership) throw new CliError(`組織 ${slug} に所属していません`);
  saveConfig({ ...config, organization_id: membership.organization.id, organization_slug: membership.organization.slug });
  console.log(`組織を選びました: ${membership.organization.name}`);
}

// ---------------------------------------------------------------------------
// services / connect / oauth-app
// ---------------------------------------------------------------------------

async function findConnector(api: ApiClient, key: string): Promise<{ connector: ConnectorDto; entry: ProviderCatalogEntryDto | null }> {
  const catalog = await api.get<ProviderCatalogEntryDto[]>("/connectors/catalog");
  const entry = catalog.find((item) => item.key === key) ?? null;
  if (entry?.auth_kind === "github_app") throw new CliError("GitHub は `agent-studio github connect` で接続します");
  if (entry) {
    const connector = await api.post<ConnectorDto>(`/connectors/catalog/${encodeURIComponent(key)}/ensure`);
    return { connector, entry };
  }
  const connectors = await api.get<ConnectorDto[]>("/connectors");
  const connector = connectors.find((item) => item.key === key || item.provider_key === key);
  if (!connector) throw new CliError(`連携サービス ${key} が見つかりません。\`agent-studio services\` で一覧を確認してください`);
  return { connector, entry: null };
}

export async function services(): Promise<void> {
  const api = new ApiClient(loadConfig());
  const [catalog, connectors, connections] = await Promise.all([
    api.get<ProviderCatalogEntryDto[]>("/connectors/catalog"),
    api.get<ConnectorDto[]>("/connectors"),
    api.get<ConnectionDto[]>("/connections"),
  ]);
  const state = (connector: ConnectorDto | undefined) => {
    if (!connector) return "未登録";
    if (connector.auth_type === "none") return "接続済み（認証不要）";
    const usable = connections.some((connection) => connection.connector_id === connector.id && connection.status === "connected" && connection.has_secret);
    return usable ? "接続済み" : "接続が必要";
  };
  console.log("カタログ（`agent-studio connect <key>` で接続）");
  for (const entry of catalog) {
    const connector = connectors.find((item) => (item.provider_key ?? item.key) === entry.key);
    const method = entry.auth_kind === "oauth2" ? "OAuth" : entry.auth_kind === "static_bearer" ? "APIキー" : entry.auth_kind === "github_app" ? "GitHub App" : "認証不要";
    console.log(`  ${entry.key.padEnd(20)} ${entry.name.padEnd(22)} ${method.padEnd(10)} ${state(connector)}`);
  }
  const others = connectors.filter((connector) => !catalog.some((entry) => entry.key === (connector.provider_key ?? connector.key)));
  if (others.length) {
    console.log("\nその他の連携サービス");
    for (const connector of others) console.log(`  ${connector.key.padEnd(20)} ${connector.name.padEnd(22)} ${connector.auth_type.padEnd(10)} ${state(connector)}`);
  }
}

export async function connect(key: string | undefined, flags: Flags): Promise<void> {
  if (!key) throw new CliError("連携サービスの key を指定してください（例: agent-studio connect slack）");
  const api = new ApiClient(loadConfig());
  const { connector, entry } = await findConnector(api, key);
  if (connector.auth_type === "none") {
    console.log(`${connector.name} は認証不要です。そのまま使えます`);
    return;
  }
  if (connector.auth_type === "runtime_secret") throw new CliError(`${connector.name} の認証情報は貴社 AWS に置きます。\`agent-studio runtime secret ${connector.key}\` を使ってください`);

  if (entry?.auth_kind === "oauth2") {
    const app = await api.get<{ configured: boolean }>(`/connectors/${connector.id}/oauth-app`);
    if (!app.configured) {
      throw new CliError(`${connector.name} の OAuth アプリがまだ登録されていません。オーナーが次を実行してください:\n  agent-studio oauth-app set ${key} --client-id <ID> --client-secret-stdin\n（${entry.oauth_console_url ?? "Provider の開発者画面"} で作成。Redirect URI に ${CALLBACK_URL} を登録）`);
    }
    const verifier = randomUrlSafe();
    const state = randomUrlSafe(16);
    const start = await api.post<{ authorize_url: string; scopes: string[] }>(`/connectors/${connector.id}/oauth/start`, { redirect_uri: CALLBACK_URL, state, code_challenge: pkceChallenge(verifier) });
    console.log(`${connector.name} に接続します。要求する権限: ${start.scopes.join(", ") || "（なし）"}`);
    const waiting = waitForCallback(["/callback"]);
    openBrowser(start.authorize_url);
    const { query } = await waiting;
    if (query.get("state") !== state || !query.get("code")) throw new CliError(`${connector.name} からの戻りを検証できませんでした`);
    const connection = await api.post<ConnectionDto>(`/connectors/${connector.id}/oauth/exchange`, { code: query.get("code"), redirect_uri: CALLBACK_URL, code_verifier: verifier });
    console.log(`接続しました: ${connection.name}（${connection.status}）。待機中の Agent 作成は自動で再開します`);
    return;
  }

  // API キー方式: Builder が用意した枠か、未設定の枠を使う。無ければ作る
  const connections = await api.get<ConnectionDto[]>("/connections");
  const candidate = connections.find((connection) => connection.connector_id === connector.id && connection.status !== "revoked" && (connection.metadata.managed_by === "builder" || !connection.has_secret))
    ?? connections.find((connection) => connection.connector_id === connector.id && connection.status !== "revoked");
  const connection = candidate ?? await api.post<ConnectionDto>("/connections", {
    name: flagString(flags, "name") ?? `${connector.name}（Preview用）`,
    connector_id: connector.id,
    scope: connector.adapter === "mcp" ? "openai_vault" : "studio",
    header_name: connector.adapter === "mcp" ? undefined : "Authorization",
  });
  const secret = await readSecret(flags, "secret", `${connector.name} の API キー`);
  await api.put(`/connections/${connection.id}/secret`, {
    value: secret,
    ...(connection.scope === "openai_vault" && connector.base_url ? { mcp_server_url: connector.base_url } : {}),
  });
  const validated = await api.post<ConnectionDto>(`/connections/${connection.id}/validate`);
  if (validated.status !== "connected") {
    const why = validated.status === "expired" ? "認証情報が無効か期限切れです（HTTP 401/403）" : `接続を確認できませんでした（状態: ${validated.status}）`;
    throw new CliError(`${connector.name}: ${why}。値を確認してもう一度実行してください`);
  }
  console.log(`接続しました: ${connection.name}。待機中の Agent 作成は自動で再開します`);
}

export async function oauthApp(sub: string | undefined, key: string | undefined, flags: Flags): Promise<void> {
  if (sub !== "set" || !key) throw new CliError("使い方: agent-studio oauth-app set <key> --client-id <ID> (--client-secret-stdin | --client-secret-env VAR)");
  const api = new ApiClient(loadConfig());
  const { connector, entry } = await findConnector(api, key);
  if (entry?.auth_kind !== "oauth2") throw new CliError(`${connector.name} は OAuth 方式ではありません`);
  const clientId = requireFlag(flags, "client-id", "Provider の開発者画面で発行した Client ID");
  const clientSecret = await readSecret(flags, "client-secret", "Client Secret");
  await api.put(`/connectors/${connector.id}/oauth-app`, { client_id: clientId, client_secret: clientSecret });
  console.log(`${connector.name} の OAuth アプリを保存しました。Redirect URI には次の 2 つを登録してください:\n  <Agent Studio の URL>/integrations/oauth/callback\n  ${CALLBACK_URL}\n続けて \`agent-studio connect ${key}\` で接続できます`);
}

// ---------------------------------------------------------------------------
// runtime
// ---------------------------------------------------------------------------

function printBootstrap(runtime: RuntimeDto, token: BootstrapTokenDto): void {
  const match = /^as-(.+)-(prod|stg)-runtime$/.exec(runtime.expected_role_name);
  const prefix = `agent-studio/runtime/${match?.[1] ?? "<tenant>"}/${stageShort(runtime.stage)}`;
  console.log(`\nRuntime を作成しました: ${runtime.name}（${runtime.aws_account_id} / ${runtime.aws_region}, IAM ロール ${runtime.expected_role_name}）`);
  console.log(`登録用トークン（有効期限 ${token.expires_at}、この 1 回だけ表示）を貴社 AWS の Secrets Manager に入れます:\n`);
  console.log(`  aws secretsmanager put-secret-value --secret-id ${prefix}/bootstrap-token --secret-string '${token.token}' --region ${runtime.aws_region}\n`);
  console.log("その後 infra/modules/tenant-runtime を apply すると Runtime が自動登録され、待機中の Agent 作成は自動で再開します。");
}

export async function runtime(sub: string | undefined, rest: string[], flags: Flags): Promise<void> {
  const api = new ApiClient(loadConfig());
  if (sub === "add") {
    const awsAccountId = requireFlag(flags, "aws-account", "12桁の AWS アカウント ID");
    const region = flagString(flags, "region") ?? "ap-northeast-1";
    const projectId = flagString(flags, "project");
    let created: RuntimeDto;
    if (projectId) {
      // Builder が出した「貴社 AWS に専用環境を作ります」の回答として処理する（Runtime・実行環境・Plan 証跡を Builder が用意）
      const project = await api.get<BuilderProjectDto>(`/builder-projects/${projectId}`);
      const action = project.human_actions.find((item) => item.status === "pending" && item.type === "aws_admin_action" && item.fields.some((field) => field.name === "aws_account_id"));
      if (!action) throw new CliError("この作成プロジェクトに、AWS アカウントを待っている操作はありません");
      const updated = await api.post<BuilderProjectDto>(`/builder-human-actions/${action.id}/complete`, { answers: { aws_account_id: awsAccountId, aws_region: region } });
      const answered = updated.human_actions.find((item) => item.id === action.id);
      const runtimeId = answered?.response?.runtime_id;
      const runtimes = await api.get<RuntimeDto[]>("/runtimes");
      const found = runtimes.find((item) => item.id === runtimeId) ?? runtimes.find((item) => item.aws_account_id === awsAccountId);
      if (!found) throw new CliError("Runtime を確認できませんでした");
      created = found;
    } else {
      const stage = flagString(flags, "stage") ?? "production";
      const tenant = flagString(flags, "tenant") ?? loadConfig().organization_slug?.slice(0, 40) ?? "tenant";
      created = await api.post<RuntimeDto>("/runtimes", {
        name: flagString(flags, "name") ?? `${tenant} ${stage === "production" ? "本番" : "検証"} Runtime`,
        stage,
        provisioning_type: "customer_owned",
        aws_account_id: awsAccountId,
        aws_region: region,
        expected_role_name: `as-${tenant}-${stageShort(stage)}-runtime`,
      });
      const profiles = await api.get<RuntimeProfileDto[]>("/environments");
      if (!profiles.some((profile) => profile.runtime?.id === created.id)) {
        await api.post<RuntimeProfileDto>("/environments", { type: "self_hosted", key: `self-hosted-${stageShort(stage)}-${created.id.slice(0, 8)}`, name: `貴社専用の実行環境（${stage === "production" ? "本番" : "検証"}）`, runtime_id: created.id });
      }
    }
    const token = await api.post<BootstrapTokenDto>(`/runtimes/${created.id}/bootstrap-tokens`);
    printBootstrap(created, token);
    return;
  }
  if (sub === "token") {
    const runtimeId = rest[0];
    if (!runtimeId) throw new CliError("Runtime の ID を指定してください（`agent-studio runtime list`）");
    const target = await api.get<RuntimeDto>(`/runtimes/${runtimeId}`);
    printBootstrap(target, await api.post<BootstrapTokenDto>(`/runtimes/${runtimeId}/bootstrap-tokens`));
    return;
  }
  if (sub === "list") {
    for (const item of await api.get<RuntimeDto[]>("/runtimes")) {
      console.log(`${item.id}  ${item.name.padEnd(24)} ${item.stage.padEnd(11)} ${item.status.padEnd(9)} ${item.aws_account_id}/${item.aws_region}`);
    }
    return;
  }
  if (sub === "secret") {
    // runtime_secret 方式: 値は貴社 AWS にだけ置く。ここでは接続先の登録と、AWS 側で実行するコマンドを出す
    const key = rest[0];
    if (!key) throw new CliError("連携サービスの key を指定してください");
    const { connector } = await findConnector(api, key);
    const runtimes = (await api.get<RuntimeDto[]>("/runtimes")).filter((item) => item.status !== "revoked");
    const target = runtimes.find((item) => item.id === flagString(flags, "runtime")) ?? runtimes[0];
    if (!target) throw new CliError("Runtime がありません。先に `agent-studio runtime add` を実行してください");
    const secretName = flagString(flags, "secret-name") ?? connector.key;
    const connections = await api.get<ConnectionDto[]>("/connections");
    const existing = connections.find((item) => item.connector_id === connector.id && item.runtime_id === target.id && item.status !== "revoked");
    const connection = existing ?? await api.post<ConnectionDto>("/connections", { name: `${connector.name}（${target.name}）`, connector_id: connector.id, scope: "runtime", runtime_id: target.id, runtime_secret_name: secretName });
    const match = /^as-(.+)-(prod|stg)-runtime$/.exec(target.expected_role_name);
    const prefix = `agent-studio/runtime/${match?.[1] ?? "<tenant>"}/${stageShort(target.stage)}`;
    console.log(`接続先を登録しました: ${connection.name}。値は貴社 AWS でだけ設定します:\n`);
    console.log(`  aws secretsmanager put-secret-value --secret-id ${prefix}/connections/${secretName} --secret-string '<値>' --region ${target.aws_region}\n`);
    await api.post(`/connections/${connection.id}/validate`).catch(() => undefined);
    return;
  }
  throw new CliError("使い方: agent-studio runtime add --aws-account <ID> [--region] [--project <作成プロジェクトID>] | runtime list | runtime token <id> | runtime secret <key>");
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

export async function doctor(): Promise<void> {
  const api = new ApiClient(loadConfig());
  const projects = await api.get<BuilderProjectDto[]>("/builder-projects");
  const waiting = projects.flatMap((project) => project.human_actions.filter((action) => action.status === "pending").map((action) => ({ project, action })));
  if (!waiting.length) {
    console.log("人の操作を待っている Agent 作成はありません");
    return;
  }
  const connectors = await api.get<ConnectorDto[]>("/connectors");
  for (const { project, action } of waiting) {
    console.log(`\n[${project.status}] ${project.request.slice(0, 60)}`);
    console.log(`  ${action.title}`);
    console.log(`  ${action.reason.slice(0, 160)}`);
    console.log(`  → ${cliCommandFor(action, project, connectors)}`);
  }
}

function cliCommandFor(action: HumanActionDto, project: BuilderProjectDto, connectors: ConnectorDto[]): string {
  if (action.cli_command) return action.cli_command.replace("<12桁のアカウントID>", "<AWSアカウントID>");
  const connector = connectors.find((item) => item.id === action.connector_id);
  if (connector && action.type === "oauth_consent") return `agent-studio connect ${connector.provider_key ?? connector.key}`;
  if (connector && action.type === "enter_secret") return connector.auth_type === "runtime_secret" ? `agent-studio runtime secret ${connector.key}` : `agent-studio connect ${connector.provider_key ?? connector.key} --secret-stdin`;
  if (action.type === "production_approval") return `agent-studio approve ${project.id}`;
  if (action.type === "business_rule_confirmation") return `画面で回答: /agents/${project.agent_id ?? ""}?tab=build`;
  return `画面で操作: /agents/${project.agent_id ?? ""}?tab=build`;
}

export async function approve(projectId: string | undefined): Promise<void> {
  if (!projectId) throw new CliError("作成プロジェクトの ID を指定してください");
  const api = new ApiClient(loadConfig());
  const project = await api.post<BuilderProjectDto>(`/builder-projects/${projectId}/production/approve`);
  console.log(`本番への昇格を承認しました（状態: ${project.status}）`);
}
