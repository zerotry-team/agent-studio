export type DemoApprovalMode = "manual" | "safe_auto" | "all";

type ApprovalLike = {
  tool?: string | null;
  reason: string;
};

export function parseDemoApprovalMode(value: string | undefined): DemoApprovalMode {
  if (!value || value === "safe_auto") return "safe_auto";
  if (value === "manual" || value === "all") return value;
  throw new Error(`未対応の DEMO_APPROVAL_MODE です: ${value}`);
}

export function isExternalApproval(approval: ApprovalLike): boolean {
  return approval.tool === "publish_post" || /X投稿|外部公開|SNS公開/.test(approval.reason);
}

export function approvalDecision(
  approval: ApprovalLike,
  mode: DemoApprovalMode,
  allowExternalPublish: boolean,
): "approve" | "deny" | "wait" {
  if (mode === "manual") return "wait";
  if (!isExternalApproval(approval)) return "approve";
  return mode === "all" && allowExternalPublish ? "approve" : "deny";
}

export function assertApprovalConfiguration(mode: DemoApprovalMode, allowExternalPublish: boolean): void {
  if (mode === "all" && !allowExternalPublish) {
    throw new Error("DEMO_APPROVAL_MODE=all には DEMO_ALLOW_EXTERNAL_PUBLISH=true が必要です");
  }
}
