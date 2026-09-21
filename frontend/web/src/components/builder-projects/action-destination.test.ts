import { describe, expect, it } from "vitest";
import { builderActionDestination } from "./action-destination";

describe("builderActionDestination", () => {
  it("RuntimeとGit branch配布を組織の実行・開発基盤へ案内する", () => {
    expect(builderActionDestination({ type: "aws_admin_action", resume_condition: { type: "code_workspace_runtime_ready" } })).toBe("infrastructure");
    expect(builderActionDestination({ type: "provider_app_registration", resume_condition: { type: "git_branch_published" } })).toBe("infrastructure");
  });

  it("GitHub Repository接続はGitHub App設定を直接開く", () => {
    expect(builderActionDestination({ type: "provider_app_registration", resume_condition: { type: "github_repository_connected" } })).toBe("github");
  });

  it("旧データでAgent Studio本体が選ばれていた場合もGitHub設定へ戻す", () => {
    expect(builderActionDestination({
      type: "business_rule_confirmation",
      resume_condition: { type: "builder_answers", topic: "code_workspace:organization_tool", repository_url: "https://github.com/zerotry-team/agent-studio.git" },
    })).toBe("github");
  });

  it("業務サービスのOAuth AppとSecretは連携サービスへ案内する", () => {
    expect(builderActionDestination({ type: "provider_app_registration", resume_condition: { type: "connection_status" } })).toBe("integrations");
    expect(builderActionDestination({ type: "enter_secret", resume_condition: { type: "connector_connected" } })).toBe("integrations");
  });

  it("業務回答には組織設定への案内を出さない", () => {
    expect(builderActionDestination({ type: "business_rule_confirmation", resume_condition: { type: "builder_answers" } })).toBeNull();
  });
});
