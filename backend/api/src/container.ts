import type { Deps } from "./application/deps.js";
import { AgentService } from "./application/agents.js";
import { EnvironmentService } from "./application/environments.js";
import { OrganizationService } from "./application/organizations.js";
import { RunService } from "./application/runs.js";
import { RuntimeApiService } from "./application/runtime-api.js";
import { ToolService } from "./application/tools.js";
import { InsightService, WorkflowService } from "./application/workflows.js";
import { ScheduleService } from "./application/schedules.js";
import { BuilderProjectService } from "./application/builder-projects.js";
import { BuilderConnectorService } from "./application/builder-connectors.js";
import { runtimeTokenSecret, type Env } from "./env.js";
import { createIdentityVerifier } from "./infrastructure/auth/identity-verifier.js";
import { RuntimeTokenIssuer } from "./infrastructure/auth/runtime-token.js";
import { createUserInviter } from "./infrastructure/auth/user-inviter.js";
import { DevRuntimeIdentityVerifier, StsRuntimeIdentityVerifier } from "./infrastructure/aws/sts-identity.js";
import type { Database } from "./infrastructure/db/prisma.js";
import { SystemDb, TenantDb } from "./infrastructure/db/tenant-db.js";
import { OpenAIManifestGenerator, TemplateManifestGenerator } from "./infrastructure/llm/manifest-generator.js";
import { AgentsApiProvider } from "./infrastructure/openai/agents-api-provider.js";
import { createSecretStore } from "./infrastructure/secrets/secret-store.js";
import { createObjectStore } from "./infrastructure/storage/object-store.js";
import { discoverMcpTools } from "./infrastructure/mcp/discover.js";
import type { Logger } from "./logger.js";
import { GitHubAppProvider } from "./infrastructure/git/github-app.js";
import { GitWebhookService } from "./application/git-webhooks.js";

export interface Services {
  organizations: OrganizationService;
  tools: ToolService;
  agents: AgentService;
  environments: EnvironmentService;
  runs: RunService;
  workflows: WorkflowService;
  insights: InsightService;
  runtimeApi: RuntimeApiService;
  schedules: ScheduleService;
  builderProjects: BuilderProjectService;
  builderConnectors: BuilderConnectorService;
  gitWebhooks: GitWebhookService;
}

export function buildDeps(env: Env, logger: Logger, database: Database, overrides: Partial<Deps> = {}): Deps {
  const db = new TenantDb(database.prisma);
  const secrets = overrides.secrets ?? createSecretStore(env);
  return {
    env,
    logger,
    db,
    system: new SystemDb(database.prisma),
    secrets,
    agentsApi: new AgentsApiProvider(env, db, secrets),
    generator:
      env.AGENTS_API_MODE === "fake"
        ? new TemplateManifestGenerator()
        : new OpenAIManifestGenerator(env, db, secrets, logger),
    identity: createIdentityVerifier(env),
    runtimeIdentity:
      env.RUNTIME_IDENTITY_MODE === "dev" ? new DevRuntimeIdentityVerifier() : new StsRuntimeIdentityVerifier(env.RUNTIME_SERVER_ID),
    runtimeTokens: new RuntimeTokenIssuer(runtimeTokenSecret(env), env.RUNTIME_SERVER_ID),
    inviter: createUserInviter(env),
    objects: createObjectStore(env),
    mcpDiscovery: discoverMcpTools,
    gitProvider: new GitHubAppProvider(),
    ...overrides,
  };
}

export function buildServices(deps: Deps): Services {
  return {
    organizations: new OrganizationService(deps),
    tools: new ToolService(deps),
    agents: new AgentService(deps),
    environments: new EnvironmentService(deps),
    runs: new RunService(deps),
    workflows: new WorkflowService(deps),
    insights: new InsightService(deps),
    runtimeApi: new RuntimeApiService(deps),
    schedules: new ScheduleService(deps),
    builderProjects: new BuilderProjectService(deps),
    builderConnectors: new BuilderConnectorService(deps),
    gitWebhooks: new GitWebhookService(deps),
  };
}
