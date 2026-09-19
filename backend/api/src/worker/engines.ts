import type { Prisma } from "@prisma/client";
import {
  TERMINAL_RUN_STATUSES,
  type EvalExpectations,
  type EvalRunDto,
  type RunStatus,
  type WorkflowDefinition,
} from "@agent-studio/contracts";
import type { Deps } from "../application/deps.js";
import { createRunInTx } from "../application/runs.js";
import type { WorkflowStepState } from "../application/workflows.js";
import type { Tx } from "../infrastructure/db/tenant-db.js";

const WORKFLOW_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** {{input}} と {{steps.<key>.output}} を埋め込む */
export function renderTemplate(template: string, input: string, steps: WorkflowStepState[]): string {
  return template.replace(/\{\{\s*(input|steps\.([a-z0-9-]+)\.output)\s*\}\}/g, (_m, whole: string, key?: string) => {
    if (whole === "input") return input;
    return steps.find((s) => s.key === key)?.output ?? "";
  });
}

/** Workflow を1段ずつ進める（WF-01〜03）。状態は workflow_runs.steps に持つ */
export class WorkflowEngine {
  constructor(private readonly deps: Deps) {}

  async tick(): Promise<void> {
    const items = await this.deps.system.listActiveWorkflowRuns(20);
    for (const item of items) {
      await this.deps.db
        .org(item.organization_id, (tx) => this.advance(tx, item.workflow_run_id))
        .catch((e) => this.deps.logger.error({ err: e, workflow_run_id: item.workflow_run_id }, "ワークフローを進められませんでした"));
    }
  }

  private async advance(tx: Tx, id: string): Promise<void> {
    // 複数の Worker が同時に進めないよう行をロックする
    await tx.$queryRaw`SELECT id FROM workflow_runs WHERE id = ${id}::uuid FOR UPDATE`;
    const wr = await tx.workflow_runs.findUniqueOrThrow({ where: { id } });
    if (wr.status !== "running") return;
    const def = wr.definition as unknown as WorkflowDefinition;
    const steps = wr.steps as unknown as WorkflowStepState[];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const stepDef = def.steps[i]!;
      if (step.status === "completed" || step.status === "skipped") continue;

      if (step.status === "pending") {
        if (stepDef.type === "agent") {
          try {
            const input = renderTemplate(stepDef.input_template, wr.input, steps);
            const run = await createRunInTx(tx, wr.organization_id, stepDef.deployment_id, input, wr.requested_by, { workflow_run_id: wr.id });
            step.status = "running";
            step.run_id = run.id;
          } catch (e) {
            step.status = "failed";
            step.output = `実行を始められませんでした: ${e instanceof Error ? e.message : ""}`;
            return this.save(tx, id, steps, "failed", step.key);
          }
        } else {
          const approval = await tx.approvals.create({
            data: {
              organization_id: wr.organization_id,
              workflow_run_id: wr.id,
              source: "workflow",
              tool: "workflow_approval",
              args_hash: "",
              args_preview: stepDef.message,
              reason: stepDef.name,
              expires_at: new Date(Date.now() + WORKFLOW_APPROVAL_TIMEOUT_MS),
            },
          });
          step.status = "waiting_approval";
          step.approval_id = approval.id;
          return this.save(tx, id, steps, "waiting_approval", step.key);
        }
        return this.save(tx, id, steps, "running", step.key);
      }

      if (step.status === "running" && step.run_id) {
        const run = await tx.runs.findUniqueOrThrow({ where: { id: step.run_id } });
        if (!TERMINAL_RUN_STATUSES.includes(run.status as RunStatus)) return;
        if (run.status !== "completed") {
          step.status = "failed";
          step.output = run.error ?? "エージェントの実行が完了しませんでした";
          return this.save(tx, id, steps, "failed", step.key);
        }
        step.status = "completed";
        step.output = run.output ?? "";
        continue;
      }

      if (step.status === "waiting_approval" && step.approval_id) {
        const approval = await tx.approvals.findUniqueOrThrow({ where: { id: step.approval_id } });
        if (approval.status === "pending") return this.save(tx, id, steps, "waiting_approval", step.key);
        if (approval.status !== "approved") {
          step.status = "failed";
          step.output = approval.status === "denied" ? `却下されました${approval.comment ? `: ${approval.comment}` : ""}` : "承認の期限が切れました";
          return this.save(tx, id, steps, "failed", step.key);
        }
        step.status = "completed";
        step.output = approval.comment ?? "承認されました";
        continue;
      }
    }
    await this.save(tx, id, steps, "completed", null);
  }

  private async save(tx: Tx, id: string, steps: WorkflowStepState[], status: string, current: string | null) {
    const terminal = status === "completed" || status === "failed";
    await tx.workflow_runs.update({
      where: { id },
      data: {
        steps: steps as unknown as Prisma.InputJsonValue,
        status,
        current_step: current,
        ...(terminal ? { finished_at: new Date() } : {}),
      },
    });
  }
}

/** Eval の判定（EVAL-01/02）。Run が終わったものから出力を期待値と比べる */
export class EvalEngine {
  constructor(private readonly deps: Deps) {}

  async tick(): Promise<void> {
    const items = await this.deps.system.listRunningEvalRuns(20);
    for (const item of items) {
      await this.deps.db
        .org(item.organization_id, (tx) => this.evaluate(tx, item.eval_run_id))
        .catch((e) => this.deps.logger.error({ err: e, eval_run_id: item.eval_run_id }, "Eval を判定できませんでした"));
    }
  }

  private async evaluate(tx: Tx, id: string): Promise<void> {
    const evalRun = await tx.eval_runs.findUniqueOrThrow({ where: { id } });
    const results = evalRun.results as unknown as EvalRunDto["results"];
    const cases = await tx.eval_cases.findMany({ where: { agent_id: evalRun.agent_id, organization_id: evalRun.organization_id } });

    for (const r of results) {
      if (r.status !== "pending" || !r.run_id) continue;
      const run = await tx.runs.findUnique({ where: { id: r.run_id } });
      if (!run || !TERMINAL_RUN_STATUSES.includes(run.status as RunStatus)) continue;
      const expectations = cases.find((c) => c.id === r.case_id)?.expectations as EvalExpectations | undefined;
      r.reasons = judge(run.status, run.output ?? "", run.error, expectations);
      r.status = r.reasons.length === 0 ? "passed" : "failed";
    }

    const done = results.every((r) => r.status !== "pending");
    await tx.eval_runs.update({
      where: { id },
      data: {
        results: results as unknown as Prisma.InputJsonValue,
        ...(done ? { status: results.every((r) => r.status === "passed") ? "passed" : "failed", finished_at: new Date() } : {}),
      },
    });
  }
}

export function judge(status: string, output: string, error: string | null, expectations?: EvalExpectations): string[] {
  if (status !== "completed") return [`実行が完了しませんでした（${status}）${error ? `: ${error}` : ""}`];
  const reasons: string[] = [];
  for (const s of expectations?.must_contain ?? []) {
    if (!output.includes(s)) reasons.push(`「${s}」が出力に含まれていません`);
  }
  for (const s of expectations?.must_not_contain ?? []) {
    if (output.includes(s)) reasons.push(`「${s}」が出力に含まれています`);
  }
  return reasons;
}
