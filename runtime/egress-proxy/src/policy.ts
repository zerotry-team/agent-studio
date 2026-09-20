import { isIP } from "node:net";

/**
 * 接続先のホスト名が許されるか。
 * allowPublicWeb でも IP 直指定は拒否する（private アドレスの判定は addressIsPublic が行う）。
 */
export function hostnameAllowed(hostname: string, allowedDomains: string[], allowPublicWeb = false): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (isIP(host)) return false;
  if (allowPublicWeb) return true;
  return allowedDomains.some((entry) => {
    const domain = entry.toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
    return host === domain || host.endsWith(`.${domain}`);
  });
}

export function addressIsPublic(address: string): boolean {
  if (address.includes(":")) {
    const value = address.toLowerCase();
    const mappedIpv4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value)?.[1];
    if (mappedIpv4) return addressIsPublic(mappedIpv4);
    return !(
      value === "::" ||
      value === "::1" ||
      value.startsWith("fc") ||
      value.startsWith("fd") ||
      /^fe[89ab]/.test(value) ||
      value.startsWith("ff")
    );
  }
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

export function parseConnectTarget(target: string): { hostname: string; port: number } {
  const match = /^([^:]+):(\d+)$/.exec(target);
  if (!match) throw new Error("CONNECT targetが正しくありません");
  const port = Number(match[2]);
  if (port !== 80 && port !== 443) throw new Error("許可されていないportです");
  return { hostname: match[1]!.toLowerCase(), port };
}
