import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  CreateAccountCommand,
  DescribeCreateAccountStatusCommand,
  ListAccountsCommand,
  ListOrganizationalUnitsForParentCommand,
  ListParentsCommand,
  ListRootsCommand,
  MoveAccountCommand,
  OrganizationsClient,
} from "@aws-sdk/client-organizations";
import { ECSClient, UpdateServiceCommand } from "@aws-sdk/client-ecs";
import { PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import type { Env } from "../../env.js";
import type { Logger } from "../../logger.js";

const execFileAsync = promisify(execFile);

type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration?: Date;
};

export interface ManagedAccountRequest {
  accountName: string;
  accountEmail: string;
  requestId: string | null;
}

export type ManagedAccountResult =
  | { status: "pending"; requestId: string }
  | { status: "succeeded"; accountId: string; requestId: string | null }
  | { status: "failed"; message: string; requestId: string | null };

export interface ManagedRuntimeInfrastructureInput {
  organizationId: string;
  runtimeId: string;
  accountId: string;
  tenantShort: string;
  stage: "staging" | "production";
  region: string;
}

export interface ManagedRuntimeInfrastructureOutput {
  bootstrapSecretId: string;
  clusterName: string;
  runtimeCoreServiceName: string;
  runtimeRoleName: string;
}

export interface ManagedRuntimeProvisioner {
  ensureAccount(input: ManagedAccountRequest): Promise<ManagedAccountResult>;
  applyInfrastructure(input: ManagedRuntimeInfrastructureInput): Promise<ManagedRuntimeInfrastructureOutput>;
  configureBootstrap(input: ManagedRuntimeInfrastructureInput & ManagedRuntimeInfrastructureOutput, token: string): Promise<void>;
}

/** 本番のOrganizations + Terraform実装。各操作は再実行しても同じアカウント/stateへ収束する。 */
export class AwsManagedRuntimeProvisioner implements ManagedRuntimeProvisioner {
  constructor(private readonly env: Env, private readonly logger: Logger) {}

  async ensureAccount(input: ManagedAccountRequest): Promise<ManagedAccountResult> {
    const management = await this.managementCredentials();
    const organizations = new OrganizationsClient({ region: "us-east-1", credentials: management });
    const existing = await findAccountByEmail(organizations, input.accountEmail);
    if (existing?.Id) {
      await moveToCompaniesOu(organizations, existing.Id);
      return { status: "succeeded", accountId: existing.Id, requestId: input.requestId };
    }

    if (!input.requestId) {
      const created = await organizations.send(new CreateAccountCommand({
        AccountName: input.accountName,
        Email: input.accountEmail,
        RoleName: "OrganizationAccountAccessRole",
        IamUserAccessToBilling: "DENY",
      }));
      const requestId = created.CreateAccountStatus?.Id;
      if (!requestId) throw new Error("AWS OrganizationsがCreateAccount request IDを返しませんでした");
      return { status: "pending", requestId };
    }

    const status = (await organizations.send(new DescribeCreateAccountStatusCommand({ CreateAccountRequestId: input.requestId }))).CreateAccountStatus;
    if (!status || status.State === "IN_PROGRESS") return { status: "pending", requestId: input.requestId };
    if (status.State === "FAILED") {
      return { status: "failed", requestId: input.requestId, message: status.FailureReason ?? "AWSアカウントの作成に失敗しました" };
    }
    if (!status.AccountId) throw new Error("作成済みAWSアカウントのIDを取得できませんでした");
    await moveToCompaniesOu(organizations, status.AccountId);
    return { status: "succeeded", accountId: status.AccountId, requestId: input.requestId };
  }

  async applyInfrastructure(input: ManagedRuntimeInfrastructureInput): Promise<ManagedRuntimeInfrastructureOutput> {
    const stateBucket = required(this.env.MANAGED_RUNTIME_STATE_BUCKET, "MANAGED_RUNTIME_STATE_BUCKET");
    const registry = required(this.env.MANAGED_RUNTIME_IMAGE_REGISTRY, "MANAGED_RUNTIME_IMAGE_REGISTRY");
    const imageTag = required(this.env.MANAGED_RUNTIME_IMAGE_TAG, "MANAGED_RUNTIME_IMAGE_TAG");
    const management = await this.managementCredentials();
    const root = this.env.MANAGED_RUNTIME_TERRAFORM_ROOT;
    const tempRoot = await mkdtemp(join(tmpdir(), "agent-studio-managed-runtime-"));
    const workRoot = join(tempRoot, "managed-runtime");
    try {
      await cp(root, workRoot, { recursive: true });
      await cp(join(dirname(root), "modules"), join(tempRoot, "modules"), { recursive: true });
      const awsEnv = credentialEnv(management, input.region);
      await terraform(workRoot, awsEnv, [
        "init", "-input=false", "-reconfigure",
        `-backend-config=bucket=${stateBucket}`,
        `-backend-config=key=managed-runtime/${input.organizationId}/${input.runtimeId}/terraform.tfstate`,
        `-backend-config=region=${this.env.AWS_REGION}`,
      ]);
      await terraform(workRoot, awsEnv, [
        "apply", "-input=false", "-auto-approve",
        `-var=target_account_id=${input.accountId}`,
        `-var=organization_id=${input.organizationId}`,
        `-var=runtime_id=${input.runtimeId}`,
        `-var=tenant_short=${input.tenantShort}`,
        `-var=stage=${input.stage}`,
        `-var=region=${input.region}`,
        `-var=agent_studio_url=${this.env.PUBLIC_BASE_URL}`,
        `-var=runtime_server_id=${this.env.RUNTIME_SERVER_ID}`,
        `-var=image_registry=${registry}`,
        `-var=image_tag=${imageTag}`,
      ], 45 * 60_000);
      const outputFile = join(tempRoot, "outputs.json");
      await terraform(workRoot, awsEnv, ["output", "-json"], 60_000, outputFile);
      const outputs = JSON.parse(await readFile(outputFile, "utf8")) as Record<string, { value?: unknown }>;
      return {
        bootstrapSecretId: outputString(outputs, "bootstrap_token_secret_id"),
        clusterName: outputString(outputs, "cluster_name"),
        runtimeCoreServiceName: outputString(outputs, "runtime_core_service_name"),
        runtimeRoleName: outputString(outputs, "runtime_role_name"),
      };
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  async configureBootstrap(
    input: ManagedRuntimeInfrastructureInput & ManagedRuntimeInfrastructureOutput,
    token: string,
  ): Promise<void> {
    const management = await this.managementCredentials();
    const child = await assumeRole(
      `arn:aws:iam::${input.accountId}:role/OrganizationAccountAccessRole`,
      `agent-studio-bootstrap-${input.runtimeId.slice(0, 8)}`,
      management,
      input.region,
    );
    const secrets = new SecretsManagerClient({ region: input.region, credentials: child });
    await secrets.send(new PutSecretValueCommand({ SecretId: input.bootstrapSecretId, SecretString: token }));
    const ecs = new ECSClient({ region: input.region, credentials: child });
    await ecs.send(new UpdateServiceCommand({
      cluster: input.clusterName,
      service: input.runtimeCoreServiceName,
      forceNewDeployment: true,
    }));
  }

  private async managementCredentials(): Promise<AwsCredentials> {
    const roleArn = required(this.env.MANAGED_RUNTIME_PROVISIONING_ROLE_ARN, "MANAGED_RUNTIME_PROVISIONING_ROLE_ARN");
    const credentials = await assumeRole(roleArn, "agent-studio-managed-runtime", undefined, this.env.AWS_REGION);
    this.logger.debug({ role_account: roleArn.split(":")[4] }, "Managed Runtime provisioning roleを引き受けました");
    return credentials;
  }
}

export class DisabledManagedRuntimeProvisioner implements ManagedRuntimeProvisioner {
  private unavailable(): never { throw new Error("Agent Studio管理AWSの自動構築が設定されていません"); }
  async ensureAccount(): Promise<ManagedAccountResult> { return this.unavailable(); }
  async applyInfrastructure(): Promise<ManagedRuntimeInfrastructureOutput> { return this.unavailable(); }
  async configureBootstrap(): Promise<void> { return this.unavailable(); }
}

async function assumeRole(
  roleArn: string,
  sessionName: string,
  credentials: AwsCredentials | undefined,
  region: string,
): Promise<AwsCredentials> {
  const result = await new STSClient({ region, credentials }).send(new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: sessionName.slice(0, 64),
    DurationSeconds: 3600,
  }));
  const c = result.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) throw new Error(`IAM roleを引き受けられません: ${roleArn}`);
  return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration };
}

async function findAccountByEmail(client: OrganizationsClient, email: string) {
  let nextToken: string | undefined;
  do {
    const page = await client.send(new ListAccountsCommand({ NextToken: nextToken }));
    const found = page.Accounts?.find((account) => account.Email?.toLowerCase() === email.toLowerCase() && account.Status !== "SUSPENDED");
    if (found) return found;
    nextToken = page.NextToken;
  } while (nextToken);
  return undefined;
}

async function moveToCompaniesOu(client: OrganizationsClient, accountId: string): Promise<void> {
  const root = (await client.send(new ListRootsCommand({}))).Roots?.[0]?.Id;
  if (!root) throw new Error("AWS OrganizationsのRootを取得できませんでした");
  let nextToken: string | undefined;
  let companiesOu: string | undefined;
  do {
    const page = await client.send(new ListOrganizationalUnitsForParentCommand({ ParentId: root, NextToken: nextToken }));
    companiesOu = page.OrganizationalUnits?.find((ou) => ou.Name === "Companies")?.Id;
    nextToken = page.NextToken;
  } while (!companiesOu && nextToken);
  if (!companiesOu) throw new Error("AWS OrganizationsにCompanies OUがありません");
  const currentParent = (await client.send(new ListParentsCommand({ ChildId: accountId }))).Parents?.[0]?.Id;
  if (!currentParent) throw new Error(`AWSアカウント ${accountId} の現在のOUを取得できませんでした`);
  if (currentParent === companiesOu) return;
  await client.send(new MoveAccountCommand({ AccountId: accountId, SourceParentId: currentParent, DestinationParentId: companiesOu }));
}

function credentialEnv(credentials: AwsCredentials, region: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    AWS_SESSION_TOKEN: credentials.sessionToken,
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
    TF_IN_AUTOMATION: "1",
  };
}

async function terraform(
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  timeout = 5 * 60_000,
  outputFile?: string,
): Promise<void> {
  try {
    const result = await execFileAsync("terraform", args, { cwd, env, timeout, maxBuffer: 10 * 1024 * 1024 });
    if (outputFile) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(outputFile, result.stdout, "utf8");
    }
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
    throw new Error(`Terraform ${args[0]}に失敗しました: ${stderr.slice(-3000) || (error instanceof Error ? error.message : String(error))}`);
  }
}

function outputString(outputs: Record<string, { value?: unknown }>, key: string): string {
  const value = outputs[key]?.value;
  if (typeof value !== "string" || !value) throw new Error(`Terraform output ${key} を取得できませんでした`);
  return value;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} が設定されていません`);
  return value;
}
