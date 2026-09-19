import { request } from "node:https";
import {
  DEV_IDENTITY_PROTOCOL,
  RUNTIME_SERVER_ID_HEADER,
  STS_GET_CALLER_IDENTITY_BODY,
  type SignedIdentity,
} from "@agent-studio/contracts";
import { AppError } from "../../domain/errors.js";

export interface AwsPrincipal {
  accountId: string;
  roleName: string;
  arn: string;
}

export interface RuntimeIdentityVerifier {
  verify(identity: SignedIdentity): Promise<AwsPrincipal>;
}

const STS_HOST = /^sts(\.[a-z0-9-]+)?\.amazonaws\.com(\.cn)?$/;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const invalid = (message: string) => new AppError("invalid_identity", 401, `AWS の身元を確認できません: ${message}`);

/** 例: arn:aws:sts::123456789012:assumed-role/as-sample-a-prod-runtime/0a1b2c... */
export function parseAssumedRoleArn(arn: string): AwsPrincipal | null {
  const m = /^arn:aws[a-z-]*:sts::(\d{12}):assumed-role\/([\w+=,.@-]{1,64})\/[\w+=,.@-]{1,64}$/.exec(arn);
  if (!m) return null;
  return { accountId: m[1]!, roleName: m[2]!, arn };
}

/** "20260919T063649Z" → Date */
function parseAmzDate(value: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!m) return null;
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!));
}

/**
 * 署名済み GetCallerIdentity を検証して STS に転送し、呼び出し元の IAM ロールを特定する（SEC-05 / SEC-15）。
 * Agent Studio 側の AWS 認証情報は使わない。署名は Runtime 自身のロールによるもの。
 */
export class StsRuntimeIdentityVerifier implements RuntimeIdentityVerifier {
  constructor(
    private readonly serverId: string,
    private readonly post: (url: URL, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }> = httpsPost,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async verify(identity: SignedIdentity): Promise<AwsPrincipal> {
    const url = new URL(identity.url);
    if (url.protocol !== "https:" || !STS_HOST.test(url.hostname) || url.pathname !== "/" || url.search !== "") {
      throw invalid("送信先が STS ではありません");
    }

    const body = Buffer.from(identity.body, "base64").toString("utf8");
    if (body !== STS_GET_CALLER_IDENTITY_BODY) throw invalid("リクエストの内容が正しくありません");

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(identity.headers)) headers[k.toLowerCase()] = v;

    if (headers[RUNTIME_SERVER_ID_HEADER] !== this.serverId) throw invalid("接続先の Agent Studio が一致しません");
    const signed = /SignedHeaders=([^,\s]+)/.exec(headers["authorization"] ?? "")?.[1]?.split(";") ?? [];
    if (!signed.includes(RUNTIME_SERVER_ID_HEADER) || !signed.includes("host")) {
      throw invalid("必要なヘッダが署名されていません");
    }
    if (headers["host"] && headers["host"] !== url.host) throw invalid("host ヘッダが一致しません");

    const signedAt = parseAmzDate(headers["x-amz-date"] ?? "");
    if (!signedAt || Math.abs(this.now().getTime() - signedAt.getTime()) > MAX_CLOCK_SKEW_MS) {
      throw invalid("署名の日時が古いか正しくありません");
    }

    let res: { status: number; body: string };
    try {
      res = await this.post(url, { ...headers, host: url.host }, body);
    } catch {
      throw new AppError("sts_unavailable", 503, "AWS STS に接続できませんでした。時間をおいて再試行してください");
    }
    if (res.status !== 200) throw invalid("STS が署名を受け付けませんでした");

    const arn = /<Arn>([^<]+)<\/Arn>/.exec(res.body)?.[1];
    const principal = arn ? parseAssumedRoleArn(arn) : null;
    if (!principal) throw invalid("IAM ロールの身元ではありません");
    return principal;
  }
}

/** ローカル開発用: dev://<アカウントID>/<ロール名>（本番では env.ts が起動を止める） */
export class DevRuntimeIdentityVerifier implements RuntimeIdentityVerifier {
  async verify(identity: SignedIdentity): Promise<AwsPrincipal> {
    const url = new URL(identity.url);
    if (url.protocol !== DEV_IDENTITY_PROTOCOL || !/^\d{12}$/.test(url.hostname)) throw invalid("開発用の身元の形式が正しくありません");
    const roleName = url.pathname.replace(/^\//, "");
    if (!/^[\w+=,.@-]{1,64}$/.test(roleName)) throw invalid("ロール名が正しくありません");
    return { accountId: url.hostname, roleName, arn: `arn:aws:sts::${url.hostname}:assumed-role/${roleName}/dev` };
  }
}

function httpsPost(url: URL, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", headers, timeout: 5000 }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > 64 * 1024) {
          req.destroy(new Error("response too large"));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}
