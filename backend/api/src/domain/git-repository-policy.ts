type GitHubRepositoryMetadata = Record<string, unknown>;

const CORE_REPOSITORY_NAMES = new Set(["agent-studio"]);

/**
 * 企業専用ToolはAgent Studio本体と別のRepositoryへ置く。
 * 既存Connectionにはpurposeがないため、既知の本体Repository名だけは安全側で除外する。
 */
export function isOrganizationIntegrationRepository(metadata: GitHubRepositoryMetadata): boolean {
  if (metadata.provider !== "github_app") return false;
  if (metadata.repository_purpose === "agent_studio_core") return false;
  if (metadata.repository_purpose === "organization_integrations") return true;
  const repository = typeof metadata.repository === "string" ? metadata.repository.trim().toLowerCase() : "";
  return repository.length > 0 && !CORE_REPOSITORY_NAMES.has(repository);
}
