import type { HumanActionDto } from "@agent-studio/contracts";

export type BuilderActionDestination = "infrastructure" | "integrations" | "github" | null;

/** Human Actionの種類ではなく、自動再開条件も含めて組織設定の案内先を決める。 */
export function builderActionDestination(
  action: Pick<HumanActionDto, "type" | "resume_condition">,
): BuilderActionDestination {
  const condition = action.resume_condition && typeof action.resume_condition === "object" && !Array.isArray(action.resume_condition)
    ? action.resume_condition as { type?: string; topic?: string; repository_url?: string }
    : {};
  if (condition.type === "github_repository_connected") return "github";
  if (condition.topic?.startsWith("code_workspace:") && condition.repository_url && /github\.com\/[^/]+\/agent-studio(?:\.git)?$/i.test(condition.repository_url)) return "github";
  if (action.type === "aws_admin_action"
    || ["browser_runtime_ready", "code_workspace_runtime_ready", "git_branch_published"].includes(condition.type ?? "")) {
    return "infrastructure";
  }
  if (["enter_secret", "oauth_consent", "provider_app_registration"].includes(action.type)) return "integrations";
  return null;
}
