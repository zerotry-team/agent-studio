import type { RunEventDto, ToolDto } from "@agent-studio/contracts";

/**
 * 実行の経過を「人が読む1手順」の単位へまとめる。
 * 状態の変化や実行環境の通知は仕組みの都合なので、既定では手順に含めない。
 */
export type RunStep =
  /** 利用者が出した指示 */
  | { kind: "instruction"; at: string; text: string }
  /** エージェントの発言（途中の説明、最後の報告） */
  | { kind: "message"; at: string; text: string }
  /** 連携サービスの操作。承認の依頼と結果を1つにまとめる */
  | {
      kind: "action";
      at: string;
      /** 登録した操作の識別子 */
      tool: string;
      /** 画面に出す名前。登録した表示名があればそれを使う */
      label: string;
      /** 何をする操作か（連携サービスに登録した説明） */
      description: string | null;
      connectorName: string | null;
      risk: ToolDto["risk"] | null;
      /** 送信しようとしている内容 */
      args: unknown;
      approvalId: string | null;
      approval: "none" | "pending" | "approved" | "denied";
      state: "waiting" | "running" | "succeeded" | "failed";
      error: string | null;
    }
  /** 実行環境（Runtime）の準備。複数の通知を1つにまとめる */
  | { kind: "environment"; at: string; detail: string; done: boolean }
  /** 失敗の通知 */
  | { kind: "error"; at: string; text: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** args_preview は文字列で入っているので、読めるなら JSON に戻す */
function parseArgs(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export interface BuildRunStepsOptions {
  /** 操作名 → 登録済みツール（表示名・説明・影響を引くため） */
  tools: Map<string, { tool: ToolDto; connectorName: string | null; description: string | null }>;
}

export function buildRunSteps(events: RunEventDto[], options: BuildRunStepsOptions): RunStep[] {
  const steps: RunStep[] = [];
  /** 承認が先に来るので、対応する tool.call が来るまで覚えておく */
  const open = new Map<string, Extract<RunStep, { kind: "action" }>>();
  const byApprovalId = new Map<string, Extract<RunStep, { kind: "action" }>>();
  /** 実行環境の通知は1ステップにまとめ、最新の状況だけ見せる */
  let environment: Extract<RunStep, { kind: "environment" }> | null = null;

  const describe = (name: string) => {
    const known = options.tools.get(name);
    return {
      label: known?.tool.display_name ?? name,
      description: known?.description ?? null,
      connectorName: known?.connectorName ?? null,
      risk: known?.tool.risk ?? null,
    };
  };

  for (const event of events) {
    const data = asRecord(event.data);
    switch (event.type) {
      case "message": {
        const role = str(data, "role");
        const text = str(data, "text") ?? event.summary;
        if (!text) break;
        steps.push(role === "user" ? { kind: "instruction", at: event.created_at, text } : { kind: "message", at: event.created_at, text });
        break;
      }
      case "approval.requested": {
        const tool = str(data, "tool");
        if (!tool) break;
        const step: Extract<RunStep, { kind: "action" }> = {
          kind: "action",
          at: event.created_at,
          tool,
          ...describe(tool),
          args: parseArgs(str(data, "args_preview")),
          approvalId: str(data, "approval_id"),
          approval: "pending",
          state: "waiting",
          error: null,
        };
        steps.push(step);
        open.set(tool, step);
        if (step.approvalId) byApprovalId.set(step.approvalId, step);
        break;
      }
      case "approval.decided": {
        const tool = str(data, "tool");
        const decision = str(data, "status") ?? str(data, "decision");
        const approvalId = str(data, "approval_id");
        const step = approvalId ? byApprovalId.get(approvalId) : tool ? open.get(tool) : undefined;
        if (!step) break;
        step.approval = decision === "denied" ? "denied" : "approved";
        step.state = decision === "denied" ? "failed" : "running";
        break;
      }
      case "tool.call": {
        const tool = str(data, "name") ?? str(data, "tool");
        if (!tool) break;
        const failed = Boolean(str(data, "error")) || /できませんでした/.test(event.summary ?? "");
        const existing = open.get(tool);
        if (existing) {
          existing.state = failed ? "failed" : "succeeded";
          existing.error = failed ? (str(data, "error") ?? event.summary) : null;
          open.delete(tool);
          break;
        }
        // 承認が要らない操作は、呼び出しだけで1手順になる
        steps.push({
          kind: "action",
          at: event.created_at,
          tool,
          ...describe(tool),
          args: null,
          approvalId: null,
          approval: "none",
          state: failed ? "failed" : "succeeded",
          error: failed ? (str(data, "error") ?? event.summary) : null,
        });
        break;
      }
      case "environment.status": {
        const text = event.summary ?? "";
        if (!environment) {
          environment = { kind: "environment", at: event.created_at, detail: text, done: false };
          steps.push(environment);
        }
        environment.detail = text;
        // 接続まで進んだら準備完了とみなす
        if (text.includes("接続されました")) environment.done = true;
        break;
      }
      case "error":
        steps.push({ kind: "error", at: event.created_at, text: event.summary || "エラーが発生しました" });
        break;
      default:
        // run.status / environment.status / usage / openai.event は手順にしない
        break;
    }
  }
  return steps;
}

