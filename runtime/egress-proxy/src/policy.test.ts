import { describe, expect, it } from "vitest";
import { addressIsPublic, hostnameAllowed, parseConnectTarget } from "./policy.js";

describe("egress proxy policy", () => {
  it("FQDN allowlistは完全一致かサブドメインだけを許可する", () => {
    expect(hostnameAllowed("example.com", ["example.com"])).toBe(true);
    expect(hostnameAllowed("www.example.com", ["*.example.com"])).toBe(true);
    expect(hostnameAllowed("example.com.evil.test", ["example.com"])).toBe(false);
    expect(hostnameAllowed("8.8.8.8", ["8.8.8.8"])).toBe(false);
  });

  it.each(["127.0.0.1", "10.1.2.3", "169.254.169.254", "172.16.0.1", "192.168.1.1", "::1", "fd00::1", "fe80::1", "::ffff:172.16.0.1", "ff02::1"])(
    "private/link-local addressを拒否する: %s",
    (address) => expect(addressIsPublic(address)).toBe(false),
  );
  it("public addressを許可する", () => expect(addressIsPublic("93.184.216.34")).toBe(true));
  it("CONNECTを80/443に限定する", () => {
    expect(parseConnectTarget("example.com:443")).toEqual({ hostname: "example.com", port: 443 });
    expect(() => parseConnectTarget("example.com:22")).toThrow();
  });
});
