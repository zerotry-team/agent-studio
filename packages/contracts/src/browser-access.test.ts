import { describe, expect, it } from "vitest";
import { isBrowserAccessConfigured, isBrowserCapability, usesBrowserCapability } from "./browser-access.js";

describe("browser access helpers", () => {
  it("Browser内部ToolとComputer ActionだけをBrowser能力として扱う", () => {
    expect(isBrowserCapability("browser_navigate")).toBe(true);
    expect(isBrowserCapability("browser_snapshot@2")).toBe(true);
    expect(isBrowserCapability("computer_action")).toBe(true);
    expect(isBrowserCapability("computer_action@1")).toBe(true);
    expect(isBrowserCapability("publish_post")).toBe(false);
  });

  it("選択済み能力からBrowser利用を判定する", () => {
    expect(usesBrowserCapability({ selected_tools: ["list_posts", "browser_snapshot"] })).toBe(true);
    expect(usesBrowserCapability({ selected_tools: ["list_posts"] })).toBe(false);
  });

  it("旧AgentのCapability Resolutionにselected_toolsがなくてもBrowser未使用として扱う", () => {
    expect(usesBrowserCapability({})).toBe(false);
    expect(usesBrowserCapability(null)).toBe(false);
  });

  it("publicまたは1件以上の許可ドメインがあるときだけ設定済みにする", () => {
    expect(isBrowserAccessConfigured("public", [])).toBe(true);
    expect(isBrowserAccessConfigured("restricted", ["example.com"])).toBe(true);
    expect(isBrowserAccessConfigured("restricted", [])).toBe(false);
  });
});
