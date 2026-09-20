import { isIP } from "node:net";

const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain", "metadata.google.internal"]);

function blockedIp(hostname: string): boolean {
  const version = isIP(hostname.replace(/^\[|\]$/g, ""));
  // FQDN allowlistを迂回できないよう、public/privateを問わずIP literalはすべて拒否する。
  return version === 4 || version === 6;
}

export function domainAllowed(hostname: string, allowedDomains: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return allowedDomains.some((entry) => {
    const domain = entry.toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
    return host === domain || host.endsWith(`.${domain}`);
  });
}

export function assertUrlAllowed(raw: string, allowedDomains: string[], allowPublicWeb = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("URL の形式が正しくありません");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("http / https 以外のURLは開けません");
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || blockedIp(host)) throw new Error("Private IP、Link-local、Metadata endpoint、直接IPへの接続は許可されていません");
  // 公開Web全般を許可する設定でも、上の IP / metadata の拒否は必ず通す
  if (!allowPublicWeb && !domainAllowed(host, allowedDomains)) throw new Error(`許可されていないドメインです: ${host}`);
  url.username = "";
  url.password = "";
  return url;
}
