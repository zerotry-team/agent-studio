import { Sha256 } from "@aws-crypto/sha256-js";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import {
  DEV_IDENTITY_PROTOCOL,
  RUNTIME_SERVER_ID_HEADER,
  STS_GET_CALLER_IDENTITY_BODY,
  type SignedIdentity,
} from "@agent-studio/contracts";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import type { ControllerConfig } from "./config.js";

/** 呼ぶたびに新しく署名した身元証明を返す（署名時刻の許容幅が短いため、使い回さない） */
export type IdentitySigner = () => Promise<SignedIdentity>;

export function stsHostname(region: string): string {
  return region.startsWith("cn-") ? `sts.${region}.amazonaws.com.cn` : `sts.${region}.amazonaws.com`;
}

type SignerCredentials = ConstructorParameters<typeof SignatureV4>[0]["credentials"];

export interface AwsIdentitySignerOptions {
  region: string;
  serverId: string;
  /** 省略時は既定の認証情報チェーン（ECS ではタスクロール） */
  credentials?: SignerCredentials;
  now?: () => Date;
}

/**
 * 自分の IAM ロールで sts:GetCallerIdentity に SigV4 署名する（SEC-05）。
 * Agent Studio 固有のヘッダを署名対象に含め、他のサービス向けの署名を流用されないようにする（SEC-15）。
 */
export function createAwsIdentitySigner(opts: AwsIdentitySignerOptions): IdentitySigner {
  const signer = new SignatureV4({
    credentials: opts.credentials ?? fromNodeProviderChain(),
    region: opts.region,
    service: "sts",
    sha256: Sha256,
  });
  const hostname = stsHostname(opts.region);
  const now = opts.now ?? (() => new Date());

  return async () => {
    const request = new HttpRequest({
      method: "POST",
      protocol: "https:",
      hostname,
      path: "/",
      headers: {
        host: hostname,
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        [RUNTIME_SERVER_ID_HEADER]: opts.serverId,
      },
      body: STS_GET_CALLER_IDENTITY_BODY,
    });
    const signed = await signer.sign(request, { signingDate: now() });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(signed.headers)) headers[k.toLowerCase()] = String(v);
    return {
      method: "POST",
      url: `https://${hostname}/`,
      headers,
      body: Buffer.from(STS_GET_CALLER_IDENTITY_BODY, "utf8").toString("base64"),
    };
  };
}

/** ローカル開発用（Agent Studio 側も RUNTIME_IDENTITY_MODE=dev のときだけ受け付ける） */
export function createDevIdentitySigner(accountId: string, roleName: string): IdentitySigner {
  return async () => ({
    method: "POST",
    url: `${DEV_IDENTITY_PROTOCOL}//${accountId}/${roleName}`,
    headers: {},
    body: "",
  });
}

export function createIdentitySigner(config: ControllerConfig): IdentitySigner {
  return config.identity.mode === "dev"
    ? createDevIdentitySigner(config.identity.accountId, config.identity.roleName)
    : createAwsIdentitySigner({ region: config.region, serverId: config.runtimeServerId });
}
