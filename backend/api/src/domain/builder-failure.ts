import { createHash } from "node:crypto";

export const BUILDER_FAILURE_CLASSES = [
  "requirements_invalid",
  "capability_missing",
  "connection_missing",
  "permission_missing",
  "runtime_unavailable",
  "git_delivery_failed",
  "package_failed",
  "tool_registration_failed",
  "build_failed",
  "preview_failed",
  "production_failed",
  "drift_detected",
  "policy_denied",
] as const;

export type BuilderFailureClass = (typeof BUILDER_FAILURE_CLASSES)[number];

export interface BuilderFailurePolicy {
  failureClass: BuilderFailureClass;
  retryable: boolean;
  maxAttempts: number;
  backoffSeconds: number[];
  nextAction: string;
}

const POLICIES: Record<BuilderFailureClass, Omit<BuilderFailurePolicy, "failureClass">> = {
  requirements_invalid: {
    retryable: false,
    maxAttempts: 1,
    backoffSeconds: [],
    nextAction: "依頼内容の不足または矛盾を修正してください",
  },
  capability_missing: {
    retryable: false,
    maxAttempts: 1,
    backoffSeconds: [],
    nextAction: "必要な能力を追加するか、利用可能な代替手段を選択してください",
  },
  connection_missing: {
    retryable: false,
    maxAttempts: 1,
    backoffSeconds: [],
    nextAction: "必要なConnectionを接続してください。接続確認後に自動再開します",
  },
  permission_missing: {
    retryable: false,
    maxAttempts: 1,
    backoffSeconds: [],
    nextAction: "不足している権限を管理者が付与してください。検知後に自動再開します",
  },
  runtime_unavailable: {
    retryable: true,
    maxAttempts: 3,
    backoffSeconds: [15, 60],
    nextAction: "RuntimeのheartbeatとWorker状態を確認してください",
  },
  git_delivery_failed: {
    retryable: true,
    maxAttempts: 3,
    backoffSeconds: [10, 45],
    nextAction: "GitHub Appの権限、Required Checks、branch protectionを確認してください",
  },
  package_failed: {
    retryable: true,
    maxAttempts: 3,
    backoffSeconds: [10, 45],
    nextAction: "package build、scan、SBOM、署名の失敗証跡を確認してください",
  },
  tool_registration_failed: {
    retryable: true,
    maxAttempts: 3,
    backoffSeconds: [15, 60],
    nextAction: "Runtime heartbeatのdigest、source commit、署名を確認してください",
  },
  build_failed: {
    retryable: true,
    maxAttempts: 3,
    backoffSeconds: [5, 20],
    nextAction: "最後のbuild/test証跡を確認してください",
  },
  preview_failed: {
    retryable: true,
    maxAttempts: 3,
    backoffSeconds: [10, 30],
    nextAction: "Preview RunのTool Callと業務Eval証跡を確認してください",
  },
  production_failed: {
    retryable: false,
    maxAttempts: 1,
    backoffSeconds: [],
    nextAction: "自動Rollback結果を確認し、Productionの再昇格を承認してください",
  },
  drift_detected: {
    retryable: false,
    maxAttempts: 1,
    backoffSeconds: [],
    nextAction: "Build、Runtime Tool、Connectionのdriftを解消してから再検証してください",
  },
  policy_denied: {
    retryable: false,
    maxAttempts: 1,
    backoffSeconds: [],
    nextAction: "組織Policyを変更する場合は管理者承認を行ってください",
  },
};

const MATCHERS: Array<[BuilderFailureClass, RegExp]> = [
  // LLM 生成のタイムアウトは依頼内容の問題ではなく、再試行で回復する
  ["build_failed", /時間内に完了しませんでした|request was aborted|timed? ?out/i],
  ["requirements_invalid", /要件|依頼内容|invalid.*(?:request|requirement)|validation/i],
  ["connection_missing", /connection|接続|oauth|secret|credential/i],
  ["permission_missing", /permission|forbidden|unauthorized|access denied|権限|401|403/i],
  ["runtime_unavailable", /runtime|heartbeat|worker|session.*(?:timeout|disconnected)|offline/i],
  ["git_delivery_failed", /github|git\b|pull request|branch|merge|required checks/i],
  ["package_failed", /package|sbom|attestation|signature|署名|digest/i],
  ["tool_registration_failed", /tool.*(?:register|registration)|tool登録|catalog/i],
  ["preview_failed", /preview|プレビュー/i],
  ["production_failed", /production|本番|限定run/i],
  ["drift_detected", /drift|構成差分|固定時点から変化/i],
  ["policy_denied", /policy|ポリシー|denied|拒否/i],
  ["capability_missing", /capability|能力|tool.*(?:missing|not found)|未対応/i],
];

function normalizedMessage(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return raw
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<uuid>")
    .replace(/\b[0-9a-f]{40,64}\b/gi, "<digest>")
    .replace(/\b\d{3,}\b/g, "<number>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

export function classifyBuilderFailure(error: unknown): BuilderFailurePolicy & { fingerprint: string; message: string } {
  const message = error instanceof Error ? error.message : "Builder処理に失敗しました";
  const normalized = normalizedMessage(error);
  const failureClass = MATCHERS.find(([, matcher]) => matcher.test(normalized))?.[0] ?? "build_failed";
  const policy = POLICIES[failureClass];
  return {
    failureClass,
    ...policy,
    fingerprint: createHash("sha256").update(`${failureClass}\n${normalized}`).digest("hex"),
    message: message.slice(0, 2000),
  };
}

export function builderRetryDelayMs(policy: Pick<BuilderFailurePolicy, "backoffSeconds">, priorSameFingerprintAttempts: number): number {
  if (policy.backoffSeconds.length === 0) return 0;
  const index = Math.min(Math.max(priorSameFingerprintAttempts - 1, 0), policy.backoffSeconds.length - 1);
  return policy.backoffSeconds[index]! * 1000;
}
