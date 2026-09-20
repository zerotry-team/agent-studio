import { hasRoleAtLeast, type MemberRole, type Stage } from "@agent-studio/contracts";

/**
 * 画面で「表示するか・操作できるか」を決めるための権限。
 * 最終的な判定は必ず API サーバーが行う（ここは表示の出し分けだけ）。
 * ロールの強さ: viewer < operator < builder < admin < owner（docs/architecture/api.md）
 */
export interface AccessContext {
  role: MemberRole | null;
  isApprover: boolean;
  isPlatformAdmin: boolean;
}

export type Capability =
  | "view" // 組織のデータを見る
  | "run.start" // 実行・追加の指示・中止
  | "workflow.run"
  | "agent.edit" // 作成・生成・検証・新しいバージョン・公開
  | "eval.edit" // テストケースの追加・削除・テストの実行
  | "workflow.edit"
  | "tool.edit"
  | "deployment.staging"
  | "deployment.production"
  | "connection.manage"
  | "environment.manage" // 実行環境・Runtime の作成、登録用トークン、環境キーの入れ替え
  | "runtime.revoke"
  | "member.manage"
  | "policy.manage"
  | "openai.view"
  | "openai.edit"
  | "organization.edit"
  | "audit.view"
  | "usage.view"
  | "approval.decide"
  | "platform.admin";

const MIN_ROLE: Partial<Record<Capability, MemberRole>> = {
  view: "viewer",
  "run.start": "operator",
  "workflow.run": "operator",
  "agent.edit": "builder",
  "eval.edit": "builder",
  "workflow.edit": "builder",
  "tool.edit": "builder",
  "deployment.staging": "builder",
  "deployment.production": "admin",
  "connection.manage": "admin",
  "environment.manage": "admin",
  "runtime.revoke": "owner",
  "member.manage": "admin",
  "policy.manage": "admin",
  "openai.view": "admin",
  "openai.edit": "owner",
  "organization.edit": "owner",
  "audit.view": "admin",
  "usage.view": "admin",
};

export function can(ctx: AccessContext, capability: Capability): boolean {
  if (capability === "platform.admin") return ctx.isPlatformAdmin;
  if (capability === "approval.decide") return ctx.role !== null && ctx.isApprover;
  const required = MIN_ROLE[capability];
  if (!required || !ctx.role) return false;
  return hasRoleAtLeast(ctx.role, required);
}

/** このステージにデプロイ（またはデプロイの停止）できるか。production は admin 以上 */
export function canDeployTo(ctx: AccessContext, stage: Stage): boolean {
  return can(ctx, stage === "production" ? "deployment.production" : "deployment.staging");
}

/** 付与・変更できるロール。owner の付与・変更は owner だけ */
export function assignableRoles(ctx: AccessContext): MemberRole[] {
  if (!can(ctx, "member.manage")) return [];
  const all: MemberRole[] = ["viewer", "operator", "builder", "admin", "owner"];
  return ctx.role === "owner" ? all : all.filter((r) => r !== "owner");
}

/** メンバーのロールを変更・削除できるか（owner のメンバーは owner だけが操作できる） */
export function canManageMember(ctx: AccessContext, targetRole: MemberRole): boolean {
  if (!can(ctx, "member.manage")) return false;
  return targetRole !== "owner" || ctx.role === "owner";
}

export interface NavItem {
  href: string;
  label: string;
  capability: Capability;
}

/** サイドバーの項目（アイコンは components/layout 側で割り当てる） */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "ダッシュボード", capability: "view" },
  { href: "/agents", label: "エージェント", capability: "view" },
  { href: "/runs", label: "実行履歴", capability: "view" },
  { href: "/approvals", label: "承認", capability: "view" },
  { href: "/integrations", label: "連携サービス", capability: "view" },
  { href: "/usage", label: "利用状況", capability: "usage.view" },
  { href: "/settings", label: "設定", capability: "view" },
];

export function visibleNavItems(ctx: AccessContext): NavItem[] {
  return NAV_ITEMS.filter((item) => can(ctx, item.capability));
}
