import {
  createRuntimeProfileSchema,
  createRuntimeSchema,
  type CreateRuntimeInput,
  type CreateRuntimeProfileInput,
  type NetworkPolicy,
  type OpenAiTemplate,
  type ProvisioningType,
  type Stage,
} from "@agent-studio/contracts";
import { zodFieldErrors } from "@/lib/utils/zod-ja";

/** どこで実行するか（ENV-05 の 3 択 + 実行環境を使わない） */
export type EnvironmentChoice = "openai_hosted" | ProvisioningType | "none";

export type RuntimeMode = "existing" | "new";

export interface EnvironmentWizardState {
  choice: EnvironmentChoice | null;
  name: string;
  key: string;
  template: OpenAiTemplate;
  networkMode: NetworkPolicy["mode"];
  /** 接続を許可するドメイン（1 行に 1 つ） */
  allowedDomains: string;
  runtimeMode: RuntimeMode;
  runtimeId: string;
  runtimeName: string;
  stage: Stage;
  awsAccountId: string;
  awsRegion: string;
  roleName: string;
  /** IAM ロール名を組み立てるための補助入力 */
  tenantShort: string;
}

export const DEFAULT_AWS_REGION = "ap-northeast-1";

export function initialWizardState(): EnvironmentWizardState {
  return {
    choice: null,
    name: "",
    key: "",
    template: "general-python",
    networkMode: "disabled",
    allowedDomains: "",
    runtimeMode: "new",
    runtimeId: "",
    runtimeName: "",
    stage: "staging",
    awsAccountId: "",
    awsRegion: DEFAULT_AWS_REGION,
    roleName: "",
    tenantShort: "",
  };
}

export function isAwsChoice(choice: EnvironmentChoice | null): choice is ProvisioningType {
  return choice === "studio_managed" || choice === "customer_owned";
}

export function domainLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 送信する内容（検証済み） */
export type EnvironmentSubmission =
  | { kind: "profile"; input: CreateRuntimeProfileInput }
  | {
      kind: "self_hosted";
      key: string;
      name: string;
      runtime: { mode: "existing"; runtime_id: string } | { mode: "new"; input: CreateRuntimeInput };
    };

export interface WizardValidation {
  submission: EnvironmentSubmission | null;
  /**
   * 項目ごとのエラー。キーは "name" / "key" / "template" / "network.mode" / "network.allowed_domains" /
   * "runtime_id" / "runtime.<項目>"（新しく作る Runtime の項目）
   */
  errors: Record<string, string>;
}

const PLACEHOLDER_RUNTIME_ID = "00000000-0000-4000-8000-000000000000";

function commonErrors(state: EnvironmentWizardState, errors: Record<string, string>) {
  if (!state.name.trim()) errors.name = "名前を入力してください";
  if (!state.key.trim()) errors.key = "キーを入力してください";
}

/** 2 つ目の手順（設定）の入力を検証し、送信する内容を組み立てる */
export function validateWizard(state: EnvironmentWizardState): WizardValidation {
  const errors: Record<string, string> = {};
  const choice = state.choice;
  if (!choice) return { submission: null, errors: { choice: "どこで実行するかを選んでください" } };

  const key = state.key.trim();
  const name = state.name.trim();

  if (choice === "none") {
    const parsed = createRuntimeProfileSchema.safeParse({ type: "none", key, name });
    if (!parsed.success) Object.assign(errors, zodFieldErrors(parsed.error));
    commonErrors(state, errors);
    const ok = parsed.success && Object.keys(errors).length === 0;
    return { submission: ok ? { kind: "profile", input: { type: "none", key, name } } : null, errors };
  }

  if (choice === "openai_hosted") {
    const domains = domainLines(state.allowedDomains);
    const network: NetworkPolicy =
      state.networkMode === "restricted" ? { mode: "restricted", allowed_domains: domains } : { mode: state.networkMode };
    const input: CreateRuntimeProfileInput = { type: "openai_hosted", key, name, template: state.template, network };
    const parsed = createRuntimeProfileSchema.safeParse(input);
    if (!parsed.success) {
      for (const [path, message] of Object.entries(zodFieldErrors(parsed.error))) {
        const match = /^network\.allowed_domains\.(\d+)$/.exec(path);
        if (match) {
          const index = Number(match[1]);
          if (!errors["network.allowed_domains"]) {
            errors["network.allowed_domains"] = `${index + 1} 行目（${domains[index] ?? ""}）: ${message}`;
          }
        } else if (path === "network.allowed_domains" && domains.length === 0) {
          errors[path] = "接続を許可するドメインを 1 件以上入力してください";
        } else if (!(path in errors)) {
          errors[path] = message;
        }
      }
    }
    commonErrors(state, errors);
    const ok = parsed.success && Object.keys(errors).length === 0;
    return { submission: ok ? { kind: "profile", input } : null, errors };
  }

  // AWS で実行する（Agent Studio が用意する AWS / 自社の AWS アカウント）
  const useExisting = state.runtimeMode === "existing";
  const profileParsed = createRuntimeProfileSchema.safeParse({
    type: "self_hosted",
    key,
    name,
    runtime_id: useExisting ? state.runtimeId : PLACEHOLDER_RUNTIME_ID,
  });
  if (!profileParsed.success) Object.assign(errors, zodFieldErrors(profileParsed.error));
  commonErrors(state, errors);

  if (useExisting) {
    delete errors.runtime_id;
    if (!state.runtimeId) errors.runtime_id = "使う Runtime を選んでください";
    const ok = profileParsed.success && Object.keys(errors).length === 0;
    return {
      submission: ok ? { kind: "self_hosted", key, name, runtime: { mode: "existing", runtime_id: state.runtimeId } } : null,
      errors,
    };
  }

  const runtimeInput: CreateRuntimeInput = {
    name: state.runtimeName.trim(),
    stage: state.stage,
    provisioning_type: choice,
    aws_account_id: state.awsAccountId.trim(),
    aws_region: state.awsRegion.trim(),
    expected_role_name: state.roleName.trim(),
  };
  const runtimeParsed = createRuntimeSchema.safeParse(runtimeInput);
  if (!runtimeParsed.success) {
    for (const [path, message] of Object.entries(zodFieldErrors(runtimeParsed.error))) errors[`runtime.${path}`] = message;
  }
  if (!runtimeInput.name) errors["runtime.name"] = "Runtime の名前を入力してください";
  if (!runtimeInput.aws_account_id) errors["runtime.aws_account_id"] = "AWS アカウント ID を入力してください";
  if (!runtimeInput.aws_region) errors["runtime.aws_region"] = "リージョンを入力してください";
  if (!runtimeInput.expected_role_name) errors["runtime.expected_role_name"] = "IAM ロール名を入力してください";

  const ok = profileParsed.success && runtimeParsed.success && Object.keys(errors).length === 0;
  return {
    submission: ok ? { kind: "self_hosted", key, name, runtime: { mode: "new", input: runtimeInput } } : null,
    errors,
  };
}

const RUNTIME_ONLY_FIELDS = ["stage", "provisioning_type", "aws_account_id", "aws_region", "expected_role_name"];

/**
 * サーバーから返った項目ごとのエラーを、画面の項目に対応づける。
 * AWS で実行する場合、サーバーは Runtime の項目を "aws_account_id" のように返すため、
 * Runtime の項目が含まれていれば "name" も Runtime の名前として扱う。
 */
export function mapServerErrors(fieldErrors: Record<string, string>, state: EnvironmentWizardState): Record<string, string> {
  if (!isAwsChoice(state.choice) || state.runtimeMode !== "new") return fieldErrors;
  const keys = Object.keys(fieldErrors);
  const isRuntimeError = keys.some((k) => RUNTIME_ONLY_FIELDS.includes(k));
  if (!isRuntimeError) return fieldErrors;
  const out: Record<string, string> = {};
  for (const [key, message] of Object.entries(fieldErrors)) out[`runtime.${key}`] = message;
  return out;
}
