import { createPrivateKey, createSign, generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConnectionDto } from "@agent-studio/contracts";
import { ApiClient, CliError } from "./api.js";
import { CALLBACK_URL, openBrowser, randomUrlSafe, serveOnce, waitForCallback } from "./browser.js";
import { CALLBACK_PORT, configDir, loadConfig } from "./config.js";
import { flagString, prompt } from "./input.js";

type Flags = Record<string, string | true>;

const GITHUB_API = "https://api.github.com";

function appJwt(appId: string, pem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: appId })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(createPrivateKey(pem)).toString("base64url");
  return `${unsigned}.${signature}`;
}

async function github<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "agent-studio-cli", "x-github-api-version": "2022-11-28", ...(init.headers ?? {}) },
  });
  const body = (await response.json().catch(() => null)) as T & { message?: string };
  if (!response.ok) throw new CliError(`GitHub API がエラーを返しました（HTTP ${response.status}）: ${body?.message ?? ""}`);
  return body;
}

/**
 * GitHub App を manifest flow で作り、インストール後に Repository を選び、Agent Studio に接続する。
 * 人がやるのは、ブラウザで「Create GitHub App」と「Install」を押すことだけ。
 * 秘密鍵と Webhook secret は API へ直接送り、Secret Store にだけ保存される（ローカルには残さない）。
 */
export async function githubConnect(flags: Flags): Promise<void> {
  const config = loadConfig();
  const api = new ApiClient(config);
  const org = flagString(flags, "org");
  const slug = config.organization_slug ?? "agent-studio";
  const appName = flagString(flags, "app-name") ?? `agent-studio-${slug}`.slice(0, 34);
  const setupUrl = `http://127.0.0.1:${CALLBACK_PORT}/github/setup`;
  const redirectUrl = `http://127.0.0.1:${CALLBACK_PORT}/github/callback`;
  const state = randomUrlSafe(16);
  const manifest = {
    name: appName,
    url: api.origin,
    hook_attributes: { url: `${api.origin}/webhooks/github`, active: true },
    redirect_url: redirectUrl,
    setup_url: setupUrl,
    setup_on_update: false,
    public: false,
    default_permissions: { administration: "write", contents: "write", pull_requests: "write", checks: "read", metadata: "read" },
    default_events: ["pull_request", "push", "check_suite", "deployment"],
  };
  const target = org ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${state}` : `https://github.com/settings/apps/new?state=${state}`;
  const html = `<html><body style="font-family:sans-serif"><p>GitHub へ移動しています…</p>
<form id="f" method="post" action="${target}"><input type="hidden" name="manifest" id="m"></form>
<script>document.getElementById("m").value=${JSON.stringify(JSON.stringify(manifest))};document.getElementById("f").submit();</script></body></html>`;

  console.log("1/3 GitHub App を作成します。ブラウザで「Create GitHub App」を押してください。");
  const callback = waitForCallback(["/github/callback"], { page: "<html><body style=\"font-family:sans-serif\"><p>GitHub App を作成しました。続けてインストール画面へ進みます。この画面は閉じて構いません。</p></body></html>" });
  const page = serveOnce("/github/start", html);
  openBrowser(`http://127.0.0.1:${CALLBACK_PORT + 1}/github/start`);
  await page;
  const { query } = await callback;
  if (query.get("state") !== state || !query.get("code")) throw new CliError("GitHub からの戻りを検証できませんでした");
  const conversion = await github<{ id: number; slug: string; pem: string; webhook_secret: string; html_url: string }>(`/app-manifests/${query.get("code")}/conversions`, "", { method: "POST", headers: { authorization: "" } });

  console.log(`2/3 App「${conversion.slug}」を作成しました。ブラウザで対象の組織にインストールしてください。`);
  const installed = waitForCallback(["/github/setup"]);
  openBrowser(`${conversion.html_url}/installations/new`);
  const installation = (await installed).query.get("installation_id");
  if (!installation) throw new CliError("インストール ID を受け取れませんでした");

  const jwt = appJwt(String(conversion.id), conversion.pem);
  const access = await github<{ token: string }>(`/app/installations/${installation}/access_tokens`, jwt, { method: "POST" });
  const repos = await github<{ repositories: Array<{ id: number; name: string; owner: { login: string }; default_branch: string }> }>("/installation/repositories?per_page=100", access.token);
  let repo = flagString(flags, "repo")
    ? repos.repositories.find((item) => `${item.owner.login}/${item.name}` === flagString(flags, "repo"))
    : repos.repositories.length === 1 ? repos.repositories[0] : undefined;
  if (!repo) {
    if (!repos.repositories.length) throw new CliError("インストール先に Repository がありません。Agent 用の private Repository を 1 つ作ってからやり直してください");
    console.log("接続する Repository を選んでください:");
    repos.repositories.forEach((item, index) => console.log(`  ${index + 1}. ${item.owner.login}/${item.name}`));
    const answer = Number(await prompt("番号: "));
    repo = repos.repositories[answer - 1];
    if (!repo) throw new CliError("番号が正しくありません");
  }

  // Adapter package の署名鍵。CI が秘密鍵で署名し、Agent Studio は公開鍵で検証する
  let publicKey: string;
  const keyFile = flagString(flags, "signing-public-key-file");
  if (keyFile) {
    publicKey = readFileSync(keyFile, "utf8");
  } else {
    const pair = generateKeyPairSync("ed25519");
    publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    const dir = join(configDir(), "signing-keys");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const privatePath = join(dir, `${repo.owner.login}-${repo.name}.pem`);
    writeFileSync(privatePath, pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
    console.log(`署名用の鍵ペアを生成しました。秘密鍵（${privatePath}）は GitHub Actions の secret ADAPTER_SIGNING_KEY に登録してください。`);
  }

  console.log("3/3 Agent Studio に接続を登録します。");
  const connection = await api.post<ConnectionDto>("/connections/github-app", {
    name: flagString(flags, "name") ?? `GitHub App (${repo.owner.login}/${repo.name})`,
    app_id: String(conversion.id),
    private_key: conversion.pem,
    webhook_secret: conversion.webhook_secret,
    installation_id: String(installation),
    repository_id: String(repo.id),
    owner: repo.owner.login,
    repository: repo.name,
    base_branch: repo.default_branch,
    package_signing_public_key: publicKey,
  });
  console.log(`接続しました: ${connection.name}。待機中の Agent 作成は自動で再開します。Webhook URL: ${api.origin}/webhooks/github`);
}

export { CALLBACK_URL as GITHUB_CALLBACK_HINT };
