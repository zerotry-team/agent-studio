import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
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

/** {{input}} と {{steps.<key>.output}}、JSON出力内のpathを埋め込む。 */
export function renderTemplate(template: string, input: string, steps: WorkflowStepState[]): string {
  return template.replace(
    /\{\{\s*(input(?:\.([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*))?|steps\.([a-z0-9-]+)\.output(?:\.([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*))?)\s*\}\}/g,
    (_m, whole: string, inputPath?: string, stepKey?: string, outputPath?: string) => {
      if (whole === "input") return input;
      const value = whole.startsWith("input.")
        ? atPath(jsonValue(input), inputPath ?? "")
        : atPath(jsonValue(steps.find((step) => step.key === stepKey)?.output ?? ""), outputPath ?? "");
      if (value === undefined || value === null) return "";
      return typeof value === "string" ? value : JSON.stringify(value);
    },
  );
}

/**
 * Tool引数用テンプレート。値をJSONとして埋め込むため、文字列・配列・objectでも
 * JSONの構造を壊さない。生の申込入力や前段Toolの返却値をLLMで再解釈しない。
 */
export function renderArgumentsTemplate(
  template: string,
  input: string,
  steps: WorkflowStepState[],
  workflowRunId: string,
): string {
  const parsedInput = jsonValue(input);
  return template.replace(
    /\{\{\s*(workflow_run_id|input(?:\.([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*))?|steps\.([a-z0-9-]+)\.output(?:\.([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*))?)\s*\}\}/g,
    (_match, whole: string, inputPath?: string, stepKey?: string, outputPath?: string) => {
      let value: unknown;
      if (whole === "workflow_run_id") value = workflowRunId;
      else if (whole === "input" || whole.startsWith("input.")) value = atPath(parsedInput, inputPath ?? "");
      else value = atPath(jsonValue(steps.find((candidate) => candidate.key === stepKey)?.output ?? ""), outputPath ?? "");
      if (value === undefined) throw new Error(`Tool引数テンプレートの参照先がありません: ${whole}`);
      return JSON.stringify(value);
    },
  );
}

function nextKey(definition: WorkflowDefinition, key: string): string | null {
  const index = definition.steps.findIndex((step) => step.key === key);
  const step = definition.steps[index];
  if (!step) return null;
  if (step.type !== "condition" && step.next) return step.next;
  if (definition.version === 2) return null;
  return definition.steps[index + 1]?.key ?? null;
}

function jsonValue(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

function atPath(value: unknown, path: string): unknown {
  if (!path) return value;
  return path.split(".").filter(Boolean).reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function evaluateCondition(step: Extract<WorkflowDefinition["steps"][number], { type: "condition" }>, input: string, steps: WorkflowStepState[]): boolean {
  const source = step.condition.source === "input"
    ? jsonValue(input)
    : jsonValue(steps.find((candidate) => candidate.key === step.condition.step_key)?.output ?? "");
  const actual = atPath(source, step.condition.path);
  const expected = step.condition.value;
  switch (step.condition.operator) {
    case "exists": return actual !== undefined && actual !== null;
    case "eq": return JSON.stringify(actual) === JSON.stringify(expected);
    case "ne": return JSON.stringify(actual) !== JSON.stringify(expected);
    case "lt": return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "lte": return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    case "gt": return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "gte": return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "in": return Array.isArray(expected) && expected.some((value) => JSON.stringify(value) === JSON.stringify(actual));
  }
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
    if (wr.status !== "running" && wr.status !== "waiting_external") return;
    const def = wr.definition as unknown as WorkflowDefinition;
    const steps = wr.steps as unknown as WorkflowStepState[];

    const currentKey = wr.current_step ?? def.start ?? def.steps[0]?.key ?? null;
    if (!currentKey) return this.finish(tx, id, steps);
    const step = steps.find((candidate) => candidate.key === currentKey);
    const stepDef = def.steps.find((candidate) => candidate.key === currentKey);
    if (!step || !stepDef) return this.save(tx, id, steps, "failed", currentKey);

    if (step.status === "completed" || step.status === "skipped") {
      return this.move(tx, id, def, steps, nextKey(def, step.key));
    }

    if (step.status === "pending") {
      if (stepDef.type === "agent" || stepDef.type === "compensate" || stepDef.type === "tool") {
        try {
          let input: string;
          if (stepDef.type === "tool") {
            const rendered = renderArgumentsTemplate(stepDef.arguments_template, wr.input, steps, wr.id);
            const args = JSON.parse(rendered) as unknown;
            if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool引数はJSON objectで指定してください");
            input = `WorkflowのToolステップです。${stepDef.tool_name} を次の引数で1回だけ実行し、返却JSONだけを出力してください。\n${JSON.stringify(args)}${this.deps.env.NODE_ENV === "test" ? `\n[[call:${stepDef.tool_name} ${JSON.stringify(args)}]]` : ""}`;
          } else {
            input = renderTemplate(stepDef.input_template, wr.input, steps);
          }
          try {
            const run = await createRunInTx(tx, wr.organization_id, stepDef.deployment_id, input, wr.requested_by, { workflow_run_id: wr.id });
            step.status = "running";
            step.run_id = run.id;
            step.attempts = (step.attempts ?? 0) + 1;
            return this.save(tx, id, steps, "running", step.key);
          } catch (e) {
            return this.failStep(tx, id, def, steps, step, stepDef, `実行を始められませんでした: ${e instanceof Error ? e.message : ""}`);
          }
        } catch (e) {
          return this.failStep(tx, id, def, steps, step, stepDef, e instanceof Error ? e.message : "Tool引数が不正です");
        }
      }
      if (stepDef.type === "condition") {
        const matched = evaluateCondition(stepDef, wr.input, steps);
        step.status = "completed";
        step.output = JSON.stringify({ matched });
        return this.move(tx, id, def, steps, matched ? stepDef.if_true : stepDef.if_false);
      }
      if (stepDef.type === "transform") {
        step.status = "completed";
        step.output = renderTemplate(stepDef.output_template, wr.input, steps);
        return this.move(tx, id, def, steps, stepDef.next ?? nextKey(def, step.key));
      }
      if (stepDef.type === "wait") {
        step.status = "running";
        step.resume_at = new Date(Date.now() + stepDef.seconds * 1000).toISOString();
        return this.save(tx, id, steps, "waiting_external", step.key);
      }
      const approvalPreview = renderTemplate(stepDef.message, wr.input, steps);
      const approval = await tx.approvals.create({
        data: {
          organization_id: wr.organization_id,
          workflow_run_id: wr.id,
          source: "workflow",
          tool: "workflow_approval",
          args_hash: createHash("sha256").update(approvalPreview).digest("hex"),
          args_preview: approvalPreview,
          reason: stepDef.name,
          expires_at: new Date(Date.now() + WORKFLOW_APPROVAL_TIMEOUT_MS),
        },
      });
      step.status = "waiting_approval";
      step.approval_id = approval.id;
      return this.save(tx, id, steps, "waiting_approval", step.key);
    }

    if (step.status === "running" && stepDef.type === "wait") {
      if (!step.resume_at || Date.parse(step.resume_at) > Date.now()) return this.save(tx, id, steps, "waiting_external", step.key);
      step.status = "completed";
      step.output = JSON.stringify({ waited_seconds: stepDef.seconds });
      return this.move(tx, id, def, steps, stepDef.next ?? nextKey(def, step.key));
    }

    if (step.status === "running" && step.run_id) {
      const run = await tx.runs.findUniqueOrThrow({ where: { id: step.run_id } });
      if (!TERMINAL_RUN_STATUSES.includes(run.status as RunStatus)) return;
      if (run.status !== "completed") {
        const retries = "retries" in stepDef ? stepDef.retries : 0;
        if ((step.attempts ?? 0) <= (retries ?? 0)) {
          step.status = "pending";
          step.run_id = null;
          step.output = run.error;
          return this.save(tx, id, steps, "running", step.key);
        }
        return this.failStep(tx, id, def, steps, step, stepDef, run.error ?? "ステップの実行が完了しませんでした");
      }
      if (stepDef.type === "tool") {
        // 外部投稿は受付完了をWorkflow完了とみなさず、provider側の終端結果まで待つ。
        // unknown/failedでも自動再投稿せず、同じ論理投稿を二重送信しない。
        const externalJob = await tx.external_jobs.findFirst({ where: { run_id: run.id }, orderBy: { created_at: "desc" } });
        if (externalJob && (externalJob.status === "pending" || externalJob.status === "processing")) {
          step.output = JSON.stringify({ provider_job_id: externalJob.provider_job_id, status: externalJob.status });
          return this.save(tx, id, steps, "waiting_external", step.key);
        }
        if (externalJob && (externalJob.status === "failed" || externalJob.status === "unknown")) {
          return this.failStep(tx, id, def, steps, step, stepDef, externalJob.error ?? `外部処理が${externalJob.status}になりました`);
        }
        step.status = "completed";
        const resultEvents = await tx.run_events.findMany({ where: { run_id: run.id, type: "tool.result" }, orderBy: { seq: "desc" }, take: 10 });
        const result = resultEvents.find((event) => {
          const data = event.data as { name?: unknown };
          return data.name === stepDef.tool_name;
        });
        const output = (result?.data as { output?: unknown } | undefined)?.output;
        step.output = typeof output === "string" ? output : run.output ?? "";
      } else {
        step.status = "completed";
        step.output = run.output ?? "";
      }
      return this.move(tx, id, def, steps, nextKey(def, step.key));
    }

    if (step.status === "waiting_approval" && step.approval_id && stepDef.type === "approval") {
      const approval = await tx.approvals.findUniqueOrThrow({ where: { id: step.approval_id } });
      if (approval.status === "pending") return this.save(tx, id, steps, "waiting_approval", step.key);
      if (approval.status !== "approved") {
        if (approval.status === "denied" && stepDef.on_denied) {
          step.status = "completed";
          step.output = `denied${approval.comment ? `: ${approval.comment}` : ""}`;
          return this.move(tx, id, def, steps, stepDef.on_denied);
        }
        step.status = "failed";
        step.output = approval.status === "denied" ? `却下されました${approval.comment ? `: ${approval.comment}` : ""}` : "承認の期限が切れました";
        return this.save(tx, id, steps, "failed", step.key);
      }
      step.status = "completed";
      step.output = approval.comment ?? "承認されました";
      return this.move(tx, id, def, steps, stepDef.next ?? nextKey(def, step.key));
    }
  }

  private async failStep(
    tx: Tx,
    id: string,
    definition: WorkflowDefinition,
    steps: WorkflowStepState[],
    step: WorkflowStepState,
    stepDef: WorkflowDefinition["steps"][number],
    message: string,
  ) {
    step.status = "failed";
    step.output = message;
    const compensate = "compensate" in stepDef ? stepDef.compensate : undefined;
    return compensate ? this.move(tx, id, definition, steps, compensate) : this.save(tx, id, steps, "failed", step.key);
  }

  private async move(tx: Tx, id: string, definition: WorkflowDefinition, steps: WorkflowStepState[], target: string | null) {
    if (!target) return this.finish(tx, id, steps);
    if (!definition.steps.some((step) => step.key === target)) return this.save(tx, id, steps, "failed", target);
    return this.save(tx, id, steps, "running", target);
  }

  private async finish(tx: Tx, id: string, steps: WorkflowStepState[]) {
    const failed = steps.some((step) => step.status === "failed");
    for (const step of steps) if (step.status === "pending") step.status = "skipped";
    return this.save(tx, id, steps, failed ? "failed" : "completed", null);
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
