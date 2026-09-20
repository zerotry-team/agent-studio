import { describe, expect, it } from "vitest";
import { assertUrlAllowed, domainAllowed } from "./policy.js";

describe("Browser egress policy", () => {
  it("許可ドメインとそのサブドメインだけを許可する", () => {
    expect(domainAllowed("example.com", ["example.com"])).toBe(true);
    expect(domainAllowed("www.example.com", ["example.com"])).toBe(true);
    expect(domainAllowed("example.com.evil.test", ["example.com"])).toBe(false);
  });

  it.each(["http://127.0.0.1", "http://169.254.169.254/latest/meta-data", "http://10.0.0.1", "https://8.8.8.8", "http://[::1]"])(
    "private / metadata / direct IP を拒否する: %s",
    (url) => expect(() => assertUrlAllowed(url, ["example.com"])).toThrow(),
  );

  it("userinfoを除去して正規化する", () => {
    expect(assertUrlAllowed("https://user:pass@example.com/path", ["example.com"]).toString()).toBe("https://example.com/path");
  });
});
