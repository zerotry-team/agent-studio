import type { Env } from "../env.js";
import type { IdentityVerifier } from "../infrastructure/auth/identity-verifier.js";
import type { RuntimeTokenIssuer } from "../infrastructure/auth/runtime-token.js";
import type { UserInviter } from "../infrastructure/auth/user-inviter.js";
import type { RuntimeIdentityVerifier } from "../infrastructure/aws/sts-identity.js";
import type { SystemDb, TenantDb } from "../infrastructure/db/tenant-db.js";
import type { ManifestGenerator } from "../infrastructure/llm/manifest-generator.js";
import type { AgentsApiProvider } from "../infrastructure/openai/agents-api-provider.js";
import type { SecretStore } from "../infrastructure/secrets/secret-store.js";
import type { ObjectStore } from "../infrastructure/storage/object-store.js";
import type { Logger } from "../logger.js";

/** アプリケーション層が使う依存（container.ts で組み立てる） */
export interface Deps {
  env: Env;
  logger: Logger;
  db: TenantDb;
  system: SystemDb;
  secrets: SecretStore;
  agentsApi: AgentsApiProvider;
  generator: ManifestGenerator;
  identity: IdentityVerifier;
  runtimeIdentity: RuntimeIdentityVerifier;
  runtimeTokens: RuntimeTokenIssuer;
  inviter: UserInviter;
  objects: ObjectStore;
}
