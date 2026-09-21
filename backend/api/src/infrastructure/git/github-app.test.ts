import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GitHubAppProvider, verifyGitHubWebhookSignature } from "./github-app.js";
import { createHmac } from "node:crypto";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const { publicKey: packageSigningPublicKey } = generateKeyPairSync("ed25519");
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const githubPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const metadata = {
  provider: "github_app" as const,
  app_id: "123",
  installation_id: "456",
  repository_id: "789",
  owner: "example",
  repository: "private-adapters",
  base_branch: "main",
  repository_url: "https://github.com/example/private-adapters.git",
  package_signing_public_key: packageSigningPublicKey.export({ type: "spki", format: "pem" }).toString(),
  permissions: { contents: "write" as const, pull_requests: "write" as const, checks: "read" as const, metadata: "read" as const },
};
const secret = { private_key: pem, webhook_secret: "a-secret-longer-than-sixteen" };

describe("GitHubAppProvider", () => {
  it("repository IDと最小権限へ限定した短期installation tokenを発行する", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual({ repository_ids: [789], permissions: metadata.permissions });
      expect(String((init?.headers as Record<string, string>).authorization)).toMatch(/^Bearer ey/);
      return new Response(JSON.stringify({ token: "installation-token-1234567890", expires_at: "2026-09-21T01:00:00.000Z" }), { status: 201 });
    });
    const provider = new GitHubAppProvider(fetchImpl as typeof fetch, "https://api.github.test", () => new Date("2026-09-21T00:00:00.000Z"));
    await expect(provider.createInstallationToken(metadata, secret)).resolves.toEqual({ token: "installation-token-1234567890", expiresAt: "2026-09-21T01:00:00.000Z" });
  });

  it("GitHubが配布するPKCS#1秘密鍵を受け付ける", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ token: "installation-token-1234567890", expires_at: "2026-09-21T01:00:00.000Z" }), { status: 201 }),
    );
    const provider = new GitHubAppProvider(fetchImpl as typeof fetch, "https://api.github.test", () => new Date("2026-09-21T00:00:00.000Z"));
    await expect(provider.createInstallationToken(metadata, { ...secret, private_key: githubPem })).resolves.toEqual({
      token: "installation-token-1234567890",
      expiresAt: "2026-09-21T01:00:00.000Z",
    });
  });

  it("All repositoriesかつAdministration writeのAppでprivate Repositoryを自動作成する", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith("/app/installations/456") && init?.method === "GET") {
        return new Response(JSON.stringify({ repository_selection: "all", permissions: { administration: "write" } }));
      }
      if (value.endsWith("/app/installations/456/access_tokens") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toMatchObject({ permissions: { administration: "write" } });
        return new Response(JSON.stringify({ token: "installation-token-1234567890", expires_at: "2026-09-21T01:00:00.000Z" }), { status: 201 });
      }
      if (value.endsWith("/repos/example/agent-studio-sample-tools") && init?.method === "GET") return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      if (value.endsWith("/orgs/example/repos") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toMatchObject({ name: "agent-studio-sample-tools", private: true, auto_init: true });
        return new Response(JSON.stringify({ id: 991, full_name: "example/agent-studio-sample-tools", default_branch: "main", private: true }), { status: 201 });
      }
      throw new Error(`unexpected ${init?.method} ${value}`);
    });
    const provider = new GitHubAppProvider(fetchImpl as typeof fetch, "https://api.github.test", () => new Date("2026-09-21T00:00:00.000Z"));
    await expect(provider.provisionOrganizationRepository({ metadata, secret, name: "agent-studio-sample-tools", description: "Sample専用" })).resolves.toMatchObject({
      id: 991,
      default_branch: "main",
      private: true,
    });
  });

  it("Selected repositoriesのAppでは作成前に停止して必要な設定を示す", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ repository_selection: "selected", permissions: { administration: "write" } })));
    const provider = new GitHubAppProvider(fetchImpl as typeof fetch, "https://api.github.test", () => new Date("2026-09-21T00:00:00.000Z"));
    await expect(provider.provisionOrganizationRepository({ metadata, secret, name: "agent-studio-sample-tools", description: "Sample専用" }))
      .rejects.toThrow("All repositories");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("同じbranchのopen PRを更新し、新規PRを増やさない", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      calls.push({ url: value, method: init?.method ?? "GET" });
      if (value.includes("access_tokens")) return new Response(JSON.stringify({ token: "installation-token-1234567890", expires_at: "2026-09-21T01:00:00.000Z" }), { status: 201 });
      const pull = { number: 7, html_url: "https://github.test/pr/7", state: "open", merged: false, merge_commit_sha: null, head: { sha: "a".repeat(40), ref: "builder/a/tool/1" }, base: { sha: "b".repeat(40), ref: "main" } };
      if (value.includes("pulls?") && init?.method === "GET") return new Response(JSON.stringify([pull]));
      if (value.endsWith("/pulls/7") && init?.method === "PATCH") return new Response(JSON.stringify(pull));
      throw new Error(`unexpected ${init?.method} ${value}`);
    });
    const provider = new GitHubAppProvider(fetchImpl as typeof fetch, "https://api.github.test", () => new Date("2026-09-21T00:00:00.000Z"));
    await provider.createOrUpdatePullRequest({ metadata, secret, branch: "builder/a/tool/1", headSha: "a".repeat(40), baseSha: "b".repeat(40), title: "title", body: "body" });
    expect(calls.some((call) => call.method === "PATCH" && call.url.endsWith("/pulls/7"))).toBe(true);
    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/pulls"))).toBe(false);
  });

  it("確認済みhead SHAを固定してPRをsquash mergeする", async () => {
    const headSha = "a".repeat(40);
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      if (value.includes("access_tokens")) return new Response(JSON.stringify({ token: "installation-token-1234567890", expires_at: "2026-09-21T01:00:00.000Z" }), { status: 201 });
      if (value.endsWith("/pulls/7/merge") && init?.method === "PUT") {
        expect(JSON.parse(String(init.body))).toEqual({ sha: headSha, merge_method: "squash" });
        return new Response(JSON.stringify({ merged: true, message: "Pull Request successfully merged", sha: "c".repeat(40) }));
      }
      throw new Error(`unexpected ${init?.method} ${value}`);
    });
    const provider = new GitHubAppProvider(fetchImpl as typeof fetch, "https://api.github.test", () => new Date("2026-09-21T00:00:00.000Z"));
    await expect(provider.mergePullRequest(metadata, secret, 7, headSha)).resolves.toMatchObject({ merged: true, sha: "c".repeat(40) });
  });

  it("webhook署名をtiming-safeに検証する", () => {
    const body = JSON.stringify({ repository: { id: 789 } });
    const signature = `sha256=${createHmac("sha256", secret.webhook_secret).update(body).digest("hex")}`;
    expect(verifyGitHubWebhookSignature(secret.webhook_secret, body, signature)).toBe(true);
    expect(verifyGitHubWebhookSignature(secret.webhook_secret, `${body}x`, signature)).toBe(false);
  });
});
