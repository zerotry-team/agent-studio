import { describe, expect, it } from "vitest";
import { isOrganizationIntegrationRepository } from "./git-repository-policy.js";

describe("isOrganizationIntegrationRepository", () => {
  it("Agent Studio本体を企業専用Toolの保存先から除外する", () => {
    expect(isOrganizationIntegrationRepository({ provider: "github_app", repository: "agent-studio" })).toBe(false);
  });

  it("会社所有のIntegration Repositoryを許可する", () => {
    expect(isOrganizationIntegrationRepository({ provider: "github_app", repository: "company-agent-tools" })).toBe(true);
  });

  it("明示された用途を優先する", () => {
    expect(isOrganizationIntegrationRepository({ provider: "github_app", repository: "agent-studio", repository_purpose: "organization_integrations" })).toBe(true);
    expect(isOrganizationIntegrationRepository({ provider: "github_app", repository: "company-agent-tools", repository_purpose: "agent_studio_core" })).toBe(false);
  });
});
