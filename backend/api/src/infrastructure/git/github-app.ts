import { createHmac, createPrivateKey, timingSafeEqual } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { z } from "zod";
import { githubAppPermissionsSchema, type GitHubAppConnectionMetadata } from "@agent-studio/contracts";

const metadataSchema = z.object({
  provider: z.literal("github_app"),
  app_id: z.string().regex(/^\d+$/),
  installation_id: z.string().regex(/^\d+$/),
  repository_id: z.string().regex(/^\d+$/),
  owner: z.string().min(1),
  repository: z.string().min(1),
  base_branch: z.string().min(1),
  repository_url: z.url(),
  repository_purpose: z.enum(["agent_studio_core", "organization_integrations"]).optional(),
  package_signing_public_key: z.string().includes("BEGIN PUBLIC KEY"),
  permissions: githubAppPermissionsSchema,
}).strict();

const secretSchema = z.object({
  private_key: z.string().min(100),
  webhook_secret: z.string().min(16),
}).strict();

export type GitHubAppSecret = z.infer<typeof secretSchema>;

export interface GitProvider {
  createInstallationToken(metadata: GitHubAppConnectionMetadata, secret: GitHubAppSecret): Promise<GitHubToken>;
  validateRepository(metadata: GitHubAppConnectionMetadata, secret: GitHubAppSecret): Promise<GitHubRepo>;
  createOrUpdatePullRequest(input: {
    metadata: GitHubAppConnectionMetadata;
    secret: GitHubAppSecret;
    branch: string;
    headSha: string;
    baseSha: string;
    title: string;
    body: string;
  }): Promise<GitHubPull>;
  getPullRequest(metadata: GitHubAppConnectionMetadata, secret: GitHubAppSecret, number: number): Promise<GitHubPull>;
  getRequiredChecks(metadata: GitHubAppConnectionMetadata, secret: GitHubAppSecret, sha: string): Promise<{ complete: boolean; successful: boolean; checks: string[] }>;
  mergePullRequest(metadata: GitHubAppConnectionMetadata, secret: GitHubAppSecret, number: number, expectedHeadSha: string): Promise<GitHubMerge>;
  provisionOrganizationRepository(input: {
    metadata: GitHubAppConnectionMetadata;
    secret: GitHubAppSecret;
    name: string;
    description: string;
  }): Promise<GitHubRepo>;
}

export function parseGitHubAppMetadata(value: unknown): GitHubAppConnectionMetadata {
  return metadataSchema.parse(value);
}

export function parseGitHubAppSecret(value: string): GitHubAppSecret {
  return secretSchema.parse(JSON.parse(value) as unknown);
}

export function verifyGitHubWebhookSignature(secret: string, rawBody: string, signature: string | null): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

type GitHubToken = { token: string; expiresAt: string };
type GitHubRepo = { id: number; full_name: string; default_branch: string; html_url?: string; private?: boolean };
type GitHubPull = {
  number: number;
  html_url: string;
  state: string;
  merged: boolean;
  merge_commit_sha: string | null;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
};
type GitHubMerge = { merged: boolean; message: string; sha: string | null };

export class GitHubAppProvider implements GitProvider {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiBase = "https://api.github.com",
    private readonly now: () => Date = () => new Date(),
  ) {}

  private headers(token: string): Record<string, string> {
    return {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2026-03-10",
      "user-agent": "agent-studio-github-app",
    };
  }

  private async json<T>(url: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) });
    const body = await response.json().catch(() => null) as T | { message?: unknown } | null;
    if (!response.ok) {
      const message = body && typeof body === "object" && "message" in body && typeof body.message === "string"
        ? body.message
        : `HTTP ${response.status}`;
      throw new Error(`GitHub App request failed: ${message}`);
    }
    return body as T;
  }

  private async appJwt(metadata: GitHubAppConnectionMetadata, secret: GitHubAppSecret): Promise<string> {
    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    const pkcs8 = createPrivateKey(secret.private_key).export({ type: "pkcs8", format: "pem" }).toString();
    const key = await importPKCS8(pkcs8, "RS256");
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(metadata.app_id)
      .setIssuedAt(nowSeconds - 60)
      .setExpirationTime(nowSeconds + 9 * 60)
      .sign(key);
  }

  async createInstallationToken(metadata: GitHubAppConnectionMetadata, secret: GitHubAppSecret): Promise<GitHubToken> {
    const jwt = await this.appJwt(metadata, secret);
    const body = await this.json<{ token: string; expires_at: string; permissions?: Record<string, string> }>(
      `${this.apiBase}/app/installations/${metadata.installation_id}/access_tokens`,
      {
        method: "POST",
        headers: { ...this.headers(jwt), "content-type": "application/json" },
        body: JSON.stringify({ repository_ids: [Number(metadata.repository_id)], permissions: metadata.permissions }),
      },
    );
    if (!body.token || !body.expires_at) throw new Error("GitHub Appがinstallation tokenを返しませんでした");
    return { token: body.token, expiresAt: body.expires_at };
  }

  async provisionOrganizationRepository(input: {
    metadata: GitHubAppConnectionMetadata;
    secret: GitHubAppSecret;
    name: string;
    description: string;
  }): Promise<GitHubRepo> {
    const jwt = await this.appJwt(input.metadata, input.secret);
    const installation = await this.json<{ repository_selection: string; permissions: Record<string, string> }>(
      `${this.apiBase}/app/installations/${input.metadata.installation_id}`,
      { method: "GET", headers: this.headers(jwt) },
    );
    if (installation.permissions.administration !== "write") {
      throw new Error("GitHub Appに Administration: write 権限がありません。権限を追加して再承認してください");
    }
    if (installation.repository_selection !== "all") {
      throw new Error("GitHub AppのRepository accessを All repositories に変更してください。作成したRepositoryへ自動接続するために必要です");
    }
    const token = await this.json<{ token: string; expires_at: string }>(
      `${this.apiBase}/app/installations/${input.metadata.installation_id}/access_tokens`,
      {
        method: "POST",
        headers: { ...this.headers(jwt), "content-type": "application/json" },
        body: JSON.stringify({ permissions: { ...input.metadata.permissions, administration: "write" } }),
      },
    );
    const repositoryUrl = `${this.apiBase}/repos/${input.metadata.owner}/${input.name}`;
    const existing = await this.fetchImpl(repositoryUrl, {
      method: "GET",
      headers: this.headers(token.token),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    let repo: GitHubRepo;
    if (existing.ok) {
      repo = await existing.json() as GitHubRepo;
    } else if (existing.status === 404) {
      repo = await this.json<GitHubRepo>(`${this.apiBase}/orgs/${input.metadata.owner}/repos`, {
        method: "POST",
        headers: { ...this.headers(token.token), "content-type": "application/json" },
        body: JSON.stringify({ name: input.name, description: input.description, private: true, auto_init: true }),
      });
    } else {
      const body = await existing.json().catch(() => null) as { message?: unknown } | null;
      throw new Error(`GitHub App request failed: ${typeof body?.message === "string" ? body.message : `HTTP ${existing.status}`}`);
    }
    if (!repo.private || repo.full_name.toLowerCase() !== `${input.metadata.owner}/${input.name}`.toLowerCase()) {
      throw new Error("企業専用Repositoryをprivateで作成できませんでした");
    }
    if (!repo.default_branch) throw new Error("作成したRepositoryのdefault branchを取得できません");
    return repo;
  }

  async validateRepository(metadata: GitHubAppConnectionMetadata, secret: GitHubAppSecret): Promise<GitHubRepo> {
    const credential = await this.createInstallationToken(metadata, secret);
    const repo = await this.json<GitHubRepo>(`${this.apiBase}/repos/${metadata.owner}/${metadata.repository}`, {
      method: "GET",
      headers: this.headers(credential.token),
    });
    if (String(repo.id) !== metadata.repository_id || repo.full_name.toLowerCase() !== `${metadata.owner}/${metadata.repository}`.toLowerCase()) {
      throw new Error("GitHub App Connectionのrepository allowlistと取得先が一致しません");
    }
    if (!repo.default_branch) throw new Error("GitHub repositoryのdefault branchを取得できません");
    return repo;
  }

  async createOrUpdatePullRequest(input: {
    metadata: GitHubAppConnectionMetadata;
    secret: GitHubAppSecret;
    branch: string;
    headSha: string;
    baseSha: string;
    title: string;
    body: string;
  }): Promise<GitHubPull> {
    const credential = await this.createInstallationToken(input.metadata, input.secret);
    const prefix = `${this.apiBase}/repos/${input.metadata.owner}/${input.metadata.repository}`;
    const query = new URLSearchParams({ state: "open", head: `${input.metadata.owner}:${input.branch}`, base: input.metadata.base_branch });
    const existing = await this.json<GitHubPull[]>(`${prefix}/pulls?${query}`, { method: "GET", headers: this.headers(credential.token) });
    const pull = existing[0]
      ? await this.json<GitHubPull>(`${prefix}/pulls/${existing[0].number}`, {
          method: "PATCH",
          headers: { ...this.headers(credential.token), "content-type": "application/json" },
          body: JSON.stringify({ title: input.title, body: input.body }),
        })
      : await this.json<GitHubPull>(`${prefix}/pulls`, {
          method: "POST",
          headers: { ...this.headers(credential.token), "content-type": "application/json" },
          body: JSON.stringify({ title: input.title, body: input.body, head: input.branch, base: input.metadata.base_branch }),
        });
    if (pull.head.sha !== input.headSha || pull.base.sha !== input.baseSha) {
      throw new Error("Pull Requestのhead/base SHAが期待値と一致しません");
    }
    return pull;
  }

  async getPullRequest(metadata: GitHubAppConnectionMetadata, secret: GitHubAppSecret, number: number): Promise<GitHubPull> {
    const credential = await this.createInstallationToken(metadata, secret);
    return this.json<GitHubPull>(`${this.apiBase}/repos/${metadata.owner}/${metadata.repository}/pulls/${number}`, {
      method: "GET",
      headers: this.headers(credential.token),
    });
  }

  async getRequiredChecks(metadata: GitHubAppConnectionMetadata, secret: GitHubAppSecret, sha: string): Promise<{ complete: boolean; successful: boolean; checks: string[] }> {
    const credential = await this.createInstallationToken(metadata, secret);
    const body = await this.json<{ check_runs: Array<{ name: string; status: string; conclusion: string | null }> }>(
      `${this.apiBase}/repos/${metadata.owner}/${metadata.repository}/commits/${sha}/check-runs`,
      { method: "GET", headers: this.headers(credential.token) },
    );
    return {
      complete: body.check_runs.length > 0 && body.check_runs.every((run) => run.status === "completed"),
      successful: body.check_runs.length > 0 && body.check_runs.every((run) => run.status === "completed" && ["success", "neutral", "skipped"].includes(run.conclusion ?? "")),
      checks: body.check_runs.map((run) => `${run.name}:${run.status}:${run.conclusion ?? "pending"}`),
    };
  }

  async mergePullRequest(metadata: GitHubAppConnectionMetadata, secret: GitHubAppSecret, number: number, expectedHeadSha: string): Promise<GitHubMerge> {
    const credential = await this.createInstallationToken(metadata, secret);
    return this.json<GitHubMerge>(`${this.apiBase}/repos/${metadata.owner}/${metadata.repository}/pulls/${number}/merge`, {
      method: "PUT",
      headers: { ...this.headers(credential.token), "content-type": "application/json" },
      body: JSON.stringify({ sha: expectedHeadSha, merge_method: "squash" }),
    });
  }
}
