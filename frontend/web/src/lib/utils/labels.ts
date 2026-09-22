import type {
  AgentVersionStatus,
  ApprovalStatus,
  AuditLogDto,
  ConnectionScope,
  DeploymentStatus,
  EvalRunDto,
  MemberRole,
  NetworkPolicy,
  OpenAiTemplate,
  Policy,
  ProvisioningType,
  RunEventType,
  RunStatus,
  RuntimeProfileType,
  RuntimeStatus,
  Stage,
  ToolExecutionLocation,
  ToolRisk,
  WorkflowRunDto,
  WorkflowRunStatus,
} from "@agent-studio/contracts";

/**
 * 画面に表示する日本語のラベル。値（英語の識別子）はそのまま API に送る。
 * Badge の色は tone（neutral / info / success / warning / danger / accent）で指定する。
 */
export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "accent";

export interface LabelWithTone {
  label: string;
  tone: Tone;
}

export const ROLE_LABELS: Record<MemberRole, string> = {
  owner: "オーナー",
  admin: "管理者",
  builder: "作成者",
  operator: "実行担当",
  viewer: "閲覧のみ",
};

export const ROLE_DESCRIPTIONS: Record<MemberRole, string> = {
  owner: "組織の設定、OpenAI のキー、実行環境の失効を含むすべての操作ができます",
  admin: "メンバー・接続先・ポリシー・実行環境の管理と、本番へのデプロイができます",
  builder: "エージェントやワークフローの作成・編集、検証用へのデプロイ、テストができます",
  operator: "デプロイ済みのエージェントを実行し、実行履歴を見られます",
  viewer: "閲覧だけができます",
};

export const STAGE_LABELS: Record<Stage, string> = {
  staging: "検証用",
  production: "本番",
};

export const RUN_STATUS: Record<RunStatus, LabelWithTone> = {
  queued: { label: "待機中", tone: "neutral" },
  provisioning: { label: "準備中", tone: "info" },
  running: { label: "実行中", tone: "info" },
  waiting_approval: { label: "承認待ち", tone: "warning" },
  waiting_input: { label: "返答待ち", tone: "warning" },
  requires_action: { label: "処理待ち", tone: "warning" },
  completed: { label: "完了", tone: "success" },
  failed: { label: "失敗", tone: "danger" },
  cancelled: { label: "中止", tone: "neutral" },
};

export const RUN_EVENT_LABELS: Record<RunEventType, string> = {
  "run.status": "状態の変化",
  "environment.status": "実行環境の状態",
  message: "メッセージ",
  "tool.call": "ツールの呼び出し",
  "tool.result": "ツールの結果",
  "external.job": "外部サービスの処理",
  "approval.requested": "承認の依頼",
  "approval.decided": "承認の結果",
  usage: "利用量",
  error: "エラー",
  "openai.event": "OpenAI のイベント",
};

export const APPROVAL_STATUS: Record<ApprovalStatus, LabelWithTone> = {
  pending: { label: "承認待ち", tone: "warning" },
  approved: { label: "承認済み", tone: "success" },
  denied: { label: "却下", tone: "danger" },
  expired: { label: "期限切れ", tone: "neutral" },
  consumed: { label: "実行済み", tone: "info" },
};

export const RUNTIME_STATUS: Record<RuntimeStatus, LabelWithTone> = {
  provisioning: { label: "構築中", tone: "info" },
  pending: { label: "準備中", tone: "info" },
  active: { label: "接続済み", tone: "success" },
  degraded: { label: "異常", tone: "warning" },
  offline: { label: "停止", tone: "danger" },
  revoked: { label: "失効", tone: "neutral" },
};

export const RUNTIME_STATUS_DESCRIPTIONS: Record<RuntimeStatus, string> = {
  provisioning: "Agent Studioが専用AWSアカウントとRuntimeを構築しています",
  pending: "登録を待っています。登録用トークンを発行し、AWS 側に設定してください",
  active: "正常に接続されています",
  degraded: "接続はしていますが、一部に問題があります",
  offline: "しばらく応答がありません。AWS 側の状態を確認してください",
  revoked: "失効しています。この Runtime では実行できません",
};

export const PROFILE_TYPE_LABELS: Record<RuntimeProfileType, string> = {
  none: "実行環境なし（ツールだけを使う）",
  openai_hosted: "OpenAIの環境",
  self_hosted: "AWS（専用の実行環境）",
};

export const PROVISIONING_TYPE_LABELS: Record<ProvisioningType, string> = {
  studio_managed: "Agent Studioが用意するAWS",
  customer_owned: "自社のAWSアカウント",
};

export const OPENAI_TEMPLATE_LABELS: Record<OpenAiTemplate, string> = {
  "general-python": "汎用（Python）",
  "browser-basic": "ブラウザ操作",
  "data-analysis": "データ分析",
  "document-processing": "文書の処理",
};

export const NETWORK_MODE_LABELS: Record<NetworkPolicy["mode"], string> = {
  disabled: "インターネットに接続しない",
  restricted: "指定したドメインだけに接続する",
  enabled: "インターネットに自由に接続する",
};

export const TOOL_RISK: Record<ToolRisk, LabelWithTone> = {
  read: { label: "読み取り", tone: "neutral" },
  write: { label: "書き込み", tone: "info" },
  external_send: { label: "外部への送信", tone: "warning" },
  financial: { label: "金額の変更", tone: "warning" },
  destructive: { label: "削除など取り消せない操作", tone: "danger" },
};

export const EXECUTION_LOCATION_LABELS: Record<ToolExecutionLocation, string> = {
  studio_function: "Agent Studio から呼び出す（Webhook）",
  openai_service_mcp: "OpenAI から接続する公開サーバー（MCP）",
  runtime_mcp: "自社の実行環境の中で動かす",
};

export const CONNECTION_SCOPE_LABELS: Record<ConnectionScope, string> = {
  studio: "Agent Studio に保管",
  openai_vault: "OpenAI の保管庫（vault）に保管",
  runtime: "自社の AWS（実行環境）に保管",
};

export const DEPLOYMENT_STATUS: Record<DeploymentStatus, LabelWithTone> = {
  active: { label: "稼働中", tone: "success" },
  superseded: { label: "置き換え済み", tone: "neutral" },
  archived: { label: "停止済み", tone: "neutral" },
};

export const AGENT_VERSION_STATUS: Record<AgentVersionStatus, LabelWithTone> = {
  draft: { label: "下書き", tone: "neutral" },
  published: { label: "公開済み", tone: "success" },
  archived: { label: "アーカイブ", tone: "neutral" },
};

export const WORKFLOW_RUN_STATUS: Record<WorkflowRunStatus, LabelWithTone> = {
  running: { label: "実行中", tone: "info" },
  waiting_approval: { label: "承認待ち", tone: "warning" },
  waiting_external: { label: "待機中", tone: "warning" },
  completed: { label: "完了", tone: "success" },
  failed: { label: "失敗", tone: "danger" },
  cancelled: { label: "中止", tone: "neutral" },
};

export type WorkflowStepStatus = WorkflowRunDto["steps"][number]["status"];

export const WORKFLOW_STEP_STATUS: Record<WorkflowStepStatus, LabelWithTone> = {
  pending: { label: "未実行", tone: "neutral" },
  running: { label: "実行中", tone: "info" },
  waiting_approval: { label: "承認待ち", tone: "warning" },
  completed: { label: "完了", tone: "success" },
  failed: { label: "失敗", tone: "danger" },
  skipped: { label: "スキップ", tone: "neutral" },
};

export const EVAL_RUN_STATUS: Record<EvalRunDto["status"], LabelWithTone> = {
  running: { label: "実行中", tone: "info" },
  passed: { label: "合格", tone: "success" },
  failed: { label: "不合格", tone: "danger" },
};

export const EVAL_RESULT_STATUS: Record<EvalRunDto["results"][number]["status"], LabelWithTone> = {
  pending: { label: "待機中", tone: "neutral" },
  passed: { label: "合格", tone: "success" },
  failed: { label: "不合格", tone: "danger" },
};

export const POLICY_TYPE_LABELS: Record<Policy["type"], string> = {
  approval: "承認が必要",
  deny: "使用を禁止",
  rate_limit: "呼び出し回数の上限",
  time_window: "使える時間帯",
};

export const POLICY_TYPE_DESCRIPTIONS: Record<Policy["type"], string> = {
  approval: "条件に当てはまる呼び出しは、承認者が承認するまで実行されません",
  deny: "条件に当てはまる呼び出しを禁止します",
  rate_limit: "1回の実行の中で、ツールを呼び出せる回数に上限を設けます",
  time_window: "指定した時間帯以外は、ツールを使えないようにします",
};

export const CONDITION_OP_LABELS: Record<string, string> = {
  ">": "より大きい",
  ">=": "以上",
  "<": "より小さい",
  "<=": "以下",
  "==": "等しい",
  "!=": "等しくない",
  in: "次のいずれか",
  not_in: "次のいずれでもない",
};

export const AUDIT_RESULT: Record<AuditLogDto["result"], LabelWithTone> = {
  success: { label: "成功", tone: "success" },
  failure: { label: "失敗", tone: "danger" },
  denied: { label: "拒否", tone: "warning" },
};

export const ACTOR_TYPE_LABELS: Record<AuditLogDto["actor_type"], string> = {
  user: "ユーザー",
  runtime: "実行環境",
  system: "システム",
};

export const ORGANIZATION_STATUS_LABELS: Record<"active" | "suspended", string> = {
  active: "利用中",
  suspended: "停止中",
};
