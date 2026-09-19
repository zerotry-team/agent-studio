import type { RuntimeDto, Stage } from "@agent-studio/contracts";

/**
 * テナント Runtime の Secrets Manager の名前（docs/architecture/deployment-contract.md §2, §5.1）
 * - 接頭辞: as-<tenant_short>-<prod|stg>
 * - secrets_prefix: agent-studio/runtime/<tenant_short>/<stage_short>
 * - IAM ロール名（expected_role_name）: as-<tenant_short>-<prod|stg>-runtime
 */
const ROLE_NAME_PATTERN = /^as-(.+)-(prod|stg)-runtime$/;

export const TENANT_PLACEHOLDER = "<tenant>";

export type StageShort = "prod" | "stg";

export function stageShort(stage: Stage): StageShort {
  return stage === "production" ? "prod" : "stg";
}

/** Terraform が作る IAM ロール名から、テナントの短い名前を取り出す（形式が違う場合は null） */
export function tenantShortFromRoleName(roleName: string): string | null {
  const match = ROLE_NAME_PATTERN.exec(roleName.trim());
  return match?.[1] ?? null;
}

/** テナントの短い名前とステージから、Terraform が作る IAM ロール名を組み立てる */
export function expectedRoleName(tenantShort: string, stage: Stage): string {
  return `as-${tenantShort}-${stageShort(stage)}-runtime`;
}

export interface RuntimeSecretsLocation {
  /** agent-studio/runtime/<tenant>/<stage> */
  prefix: string;
  /** IAM ロール名から読み取れたテナントの短い名前（読み取れない場合は null で、prefix には <tenant> が入る） */
  tenant: string | null;
  stage: StageShort;
}

export function runtimeSecretsLocation(runtime: Pick<RuntimeDto, "stage" | "expected_role_name">): RuntimeSecretsLocation {
  const tenant = tenantShortFromRoleName(runtime.expected_role_name);
  const stage = stageShort(runtime.stage);
  return { prefix: `agent-studio/runtime/${tenant ?? TENANT_PLACEHOLDER}/${stage}`, tenant, stage };
}

/** 登録用トークンを Secrets Manager に入れるコマンド */
export function bootstrapTokenCommand(location: RuntimeSecretsLocation, token: string): string {
  return `aws secretsmanager put-secret-value --secret-id ${location.prefix}/bootstrap-token --secret-string '${token}'`;
}

/** 接続先の認証情報を Secrets Manager に入れるコマンド（値は利用者が置き換える） */
export function connectionSecretCommand(
  location: Pick<RuntimeSecretsLocation, "prefix">,
  secretName: string,
  region: string,
): string {
  return `aws secretsmanager put-secret-value --secret-id ${location.prefix}/connections/${secretName} --secret-string '<値>' --region ${region}`;
}
