import type { Deps } from "./application/deps.js";
import { AgentService } from "./application/agents.js";
import { EnvironmentService } from "./application/environments.js";
import { OrganizationService } from "./application/organizations.js";
import { RunService } from "./application/runs.js";
import { RuntimeApiService } from "./application/runtime-api.js";
import { ToolService } from "./application/tools.js";
import { InsightService, WorkflowService } from "./application/workflows.js";
import { runtimeTokenSecret, type Env } from "./env.js";
import { createIdentityVerifier } from "./infrastructure/auth/identity-verifier.js";
import { RuntimeTokenIssuer } from "./infrastructure/auth/runtime-token.js";
import { createUserInviter } from "./infrastructure/auth/user-inviter.js";
import { DevRuntimeIdentityVerifier, StsRuntimeIdentityVerifier } from "./infrastructure/aws/sts-identity.js";
import type { Database } from "./infrastructure/db/prisma.js";
import { SystemDb, TenantDb } from "./infrastructure/db/tenant-db.js";
import { ClaudeManifestGenerator, TemplateManifestGenerator } from "./infrastructure/llm/manifest-generator.js";
import { AgentsApiProvider } from "./infrastructure/openai/agents-api-provider.js";
import { createSecretStore } from "./infrastructure/secrets/secret-store.js";
import { createObjectStore } from "./infrastructure/storage/object-store.js";
import type { Logger } from "./logger.js";

export interface Services {
  organizations: OrganizationService;
  tools: ToolService;
  agents: AgentService;
  environments: EnvironmentService;
  runs: RunService;
  workflows: WorkflowService;
  insights: InsightService;
  runtimeApi: RuntimeApiService;
}

export function buildDeps(env: Env, logger: Logger, database: Database, overrides: Partial<Deps> = {}): Deps {
  const db = new TenantDb(database.prisma);
  const secrets = overrides.secrets ?? createSecretStore(env);
  const anthropicKey = env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY !== "unset" ? env.ANTHROPIC_API_KEY : null;
  return {
    env,
    logger,
    db,
    system: new SystemDb(database.prisma),
    secrets,
    agentsApi: new AgentsApiProvider(env, db, secrets),
    generator: anthropicKey
      ? new ClaudeManifestGenerator(anthropicKey, env.MANIFEST_GENERATOR_MODEL, logger)
      : new TemplateManifestGenerator(),
    identity: createIdentityVerifier(env),
    runtimeIdentity:
      env.RUNTIME_IDENTITY_MODE === "dev" ? new DevRuntimeIdentityVerifier() : new StsRuntimeIdentityVerifier(env.RUNTIME_SERVER_ID),
    runtimeTokens: new RuntimeTokenIssuer(runtimeTokenSecret(env), env.RUNTIME_SERVER_ID),
    inviter: createUserInviter(env),
    objects: createObjectStore(env),
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
  };
}
