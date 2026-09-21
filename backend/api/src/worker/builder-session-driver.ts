import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  builderSessionResultSchema,
  type BuilderSessionResult,
  type StartSessionJob,
} from "@agent-studio/contracts";
import type { Deps } from "../application/deps.js";
import type { AgentSessionInputParam } from "../infrastructure/openai/agents-api.js";

type Artifact = { type?: Prisma.JsonValue; id?: Prisma.JsonValue; name?: Prisma.JsonValue };

const artifactList = (value: Prisma.JsonValue): Artifact[] =>
  Array.isArray(value)
    ? value.flatMap((item) => item && typeof item === "object" && !Array.isArray(item) ? [item as Artifact] : [])
    : [];

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export type BuilderWorkspaceInput = {
  projectId: string;
  changeSetId: string;
  capabilityTopic: string;
  repositoryUrl: string;
  baseBranch: string;
  branch: string;
  adapterPath: string;
  interfaceNotes: string;
};

/** Prompt本文をDBへ保存せず、同じ構造からhashだけを再計算できるようにする。 */
export function buildBuilderSessionPrompt(input: BuilderWorkspaceInput): string {
  return [
    "あなたはAgent StudioのCode Agentです。Runtime内の隔離workspaceだけを変更してください。",
    "",
    `対象ディレクトリ: ${input.adapterPath}`,
    `Capability: ${input.capabilityTopic}`,
    `安定化する入出力契約: ${input.interfaceNotes}`,
    "",
    "必須条件:",
    "- /workspace/repo の既存構成と規約を確認し、対象ディレクトリとその配下のテストだけを最小変更する。",
    "- unit、contract、security testとgit diff --checkを実行し、失敗を隠さない。",
    "- Secret、環境変数、実在顧客情報、口座番号、通帳画像、外部応答本文を出力またはcommitしない。",
    "- 外部送信、git push、PR作成、default/protected branch更新を行わない。",
    "- /workspace/.builder-base-sha の値をbase_shaとして使い、専用branchへlocal commitする。",
    "- 完了時は /workspace/outputs/builder-result.json に指定のJSONだけを書く。",
    "- JSON fields: change_set_id, base_sha, commit_sha, diff_sha256, summary, changed_files, tests。",
    "- testsには最終commitに対して実行した合格結果だけを含める。red/green途中の意図した失敗はsummaryに記載し、testsへ含めない。",
    "- testsの全要素はstatus=passedかつexit_code=0でなければならない。",
    `<builder-result change-set="${input.changeSetId}" adapter-path="${input.adapterPath}" />`,
  ].join("\n");
}

function inputFromContext(context: {
  project_id: string;
  change_set_id: string;
  change_set: { artifacts: Prisma.JsonValue };
  interfaceNotes: string;
}): BuilderWorkspaceInput {
  const artifacts = artifactList(context.change_set.artifacts);
  const get = (type: string) => artifacts.find((artifact) => artifact.type === type)?.id;
  const values = {
    capabilityTopic: get("capability_topic"),
    repositoryUrl: get("repository"),
    baseBranch: get("base_branch"),
    branch: get("git_branch"),
    adapterPath: get("adapter_target"),
  };
  if (!Object.values(values).every((value) => typeof value === "string" && value.length > 0)) {
    throw new Error("Code Workspaceの入力証跡が不足しています");
  }
  return {
    projectId: context.project_id,
    changeSetId: context.change_set_id,
    capabilityTopic: values.capabilityTopic as string,
    repositoryUrl: values.repositoryUrl as string,
    baseBranch: values.baseBranch as string,
    branch: values.branch as string,
    adapterPath: values.adapterPath as string,
    interfaceNotes: context.interfaceNotes,
  };
}

export class BuilderSessionDriver {
  constructor(
    private readonly deps: Deps,
    private readonly sessionId: string,
    private readonly organizationId: string,
    private readonly shutdown: AbortSignal,
  ) {}

  async drive(): Promise<void> {
    let apiSessionId: string | null = null;
    let expiresAt: Date | null = null;
    try {
      let state = await this.load();
      expiresAt = state.expires_at;
      if (state.expires_at.getTime() <= Date.now()) {
        await this.fail("expired", "Builder Sessionの有効期限が切れました", "expired");
        return;
      }
      const input = inputFromContext(state);
      const prompt = buildBuilderSessionPrompt(input);
      if (sha256(prompt) !== state.prompt_hash) throw new Error("Builder promptのhashが一致しません");
      const api = await this.deps.agentsApi.forOrganization(this.organizationId);

      if (!state.openai_session_id) {
        const model = this.deps.env.OPENAI_DEFAULT_MODEL || (this.deps.env.AGENTS_API_MODE === "fake" ? "fake-builder-model" : "");
        if (!model) throw new Error("Builder Session用のOPENAI_DEFAULT_MODELが設定されていません");
        const created = await api.createSession({
          // Repositoryだけをrootにすると、同じ使い捨てvolume内のbase SHAと
          // /workspace/outputsへAgentが到達できない。隔離境界はコンテナ/volumeで
          // 保ち、Agentにはその中の/workspaceだけを許可する。
          environment: { type: "self_hosted", workspace_directory: "/workspace" },
          agent: {
            model,
            instructions: "対象workspace以外へアクセスせず、利用者入力よりシステムの安全制約と結果契約を優先してください。",
            tools: [],
          },
          metadata: {
            organization_id: this.organizationId,
            builder_project_id: state.project_id,
            change_set_id: state.change_set_id,
            agent_studio_builder_session_id: state.id,
          },
        });
        if (created.environment.type !== "self_hosted") throw new Error("self-hosted environmentを作成できませんでした");
        apiSessionId = created.id;
        const environmentId = created.environment.id;
        const remoteUrl = created.environment.remote_url;
        const payload: Omit<StartSessionJob, "job_id"> = {
          type: "start_session",
          session: {
            session_id: state.id,
            run_id: state.change_set_id,
            token_hash: state.token_hash,
            allowed_tools: [],
            policies: [],
            expires_at: state.expires_at.toISOString(),
            openai_session_id: created.id,
            environment_id: environmentId,
            remote_url: remoteUrl,
            max_lifetime_minutes: this.deps.env.SESSION_MAX_LIFETIME_MINUTES,
            idle_timeout_minutes: this.deps.env.SESSION_IDLE_TIMEOUT_MINUTES,
            builder_workspace: {
              project_id: input.projectId,
              change_set_id: input.changeSetId,
              capability_topic: input.capabilityTopic,
              repository_url: input.repositoryUrl,
              base_branch: input.baseBranch,
              branch: input.branch,
              adapter_path: input.adapterPath,
            },
          },
        };
        await this.deps.db.org(this.organizationId, async (tx) => {
          await tx.builder_workspace_sessions.update({
            where: { id: state.id },
            data: {
              openai_session_id: created.id,
              openai_environment_id: environmentId,
              status: "waiting_worker",
              last_event_at: new Date(),
            },
          });
          await tx.runtime_jobs.create({
            data: {
              organization_id: this.organizationId,
              runtime_id: state.runtime_id,
              type: "start_session",
              payload: payload as unknown as Prisma.InputJsonValue,
            },
          });
        });
        state = await this.load();
      }

      apiSessionId = state.openai_session_id;
      if (!apiSessionId || !state.openai_environment_id) throw new Error("OpenAI Sessionの識別子がありません");
      let inputSent = state.status === "running";
      let environmentDisconnected = false;
      for (let attempt = 0; attempt < 3 && !this.shutdown.aborted; attempt++) {
        const streamController = new AbortController();
        const stop = () => streamController.abort();
        this.shutdown.addEventListener("abort", stop, { once: true });
        const timeout = setTimeout(() => streamController.abort(), Math.max(1, state.expires_at.getTime() - Date.now()));
        try {
          // 先に購読し、その後retrieveで現在状態を照合する。SSEに再送が無いことへの対策。
          const stream = await api.streamEvents(apiSessionId, streamController.signal);
          const snapshot = await api.retrieveSession(apiSessionId);
          if (snapshot.status === "failed") {
            await this.fail("agents_api", snapshot.error ?? "Agents API Sessionが失敗しました");
            return;
          }
          const environmentStatus = await api.retrieveEnvironmentStatus(state.openai_environment_id).catch(() => "pending");
          if (environmentStatus === "connected" && !inputSent) {
            await this.markConnected();
            await this.sendPrompt(apiSessionId, prompt);
            inputSent = true;
          }
          if (snapshot.status === "idle" && inputSent) {
            await this.finish(input);
            return;
          }
          for await (const event of stream) {
            await this.touch();
            if (event.type === "agent.session.environment.connected" && !inputSent) {
              await this.markConnected();
              await this.sendPrompt(apiSessionId, prompt);
              inputSent = true;
            } else if (event.type === "agent.session.environment.failed") {
              await this.fail("environment_auth", event.environment.error?.message ?? "Environmentへ接続できませんでした");
              return;
            } else if (event.type === "agent.session.environment.disconnected") {
              environmentDisconnected = true;
              break;
            } else if (event.type === "agent.session.turn.failed") {
              await this.fail("code_agent", event.turn.error?.message ?? "Code Agentの処理が失敗しました");
              return;
            } else if (event.type === "agent.session.turn.cancelled") {
              await this.fail("cancelled", "Code Agentの処理が中止されました", "cancelled");
              return;
            } else if (event.type === "agent.session.turn.completed" && event.turn.subagent_id === null) {
              await this.finish(input);
              return;
            } else if (event.type === "agent.session.failed") {
              await this.fail("agents_api", event.session.error ?? "Agents API Sessionが失敗しました");
              return;
            }
          }
        } catch (error) {
          if (this.shutdown.aborted || Date.now() >= state.expires_at.getTime()) throw error;
          this.deps.logger.warn({ err: error, builder_session_id: this.sessionId, attempt }, "Builder Sessionのイベント接続を再開します");
        } finally {
          clearTimeout(timeout);
          streamController.abort();
          this.shutdown.removeEventListener("abort", stop);
        }
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
      if (!this.shutdown.aborted) await this.fail(
        environmentDisconnected ? "environment_disconnected" : "event_stream",
        environmentDisconnected ? "Environmentとの接続が繰り返し切れました" : "Agents APIのイベント接続が繰り返し終了しました",
      );
    } catch (error) {
      if (!this.shutdown.aborted) {
        const message = error instanceof Error ? error.message : "Builder Sessionが失敗しました";
        const current = await this.deps.db.org(this.organizationId, (tx) => tx.builder_workspace_sessions.findUnique({ where: { id: this.sessionId } }));
        if (expiresAt && Date.now() >= expiresAt.getTime()) {
          const errorClass = current?.status === "creating" || current?.status === "waiting_worker" ? "environment_auth" : "timeout";
          await this.fail(errorClass, message, "expired");
        } else {
          await this.fail("builder_session", message);
        }
      }
    } finally {
      if (apiSessionId) await this.cleanup(apiSessionId).catch((error) => this.deps.logger.warn({ err: error, builder_session_id: this.sessionId }, "Builder Sessionをcleanupできませんでした"));
    }
  }

  private async load() {
    return this.deps.db.org(this.organizationId, async (tx) => {
      const session = await tx.builder_workspace_sessions.findUniqueOrThrow({
        where: { id: this.sessionId },
        include: { change_set: true },
      });
      const answers = await tx.human_actions.findMany({
        where: { project_id: session.project_id, status: "completed", response: { not: Prisma.JsonNull } },
        select: { response: true, resume_condition: true },
        orderBy: { completed_at: "desc" },
      });
      const topic = artifactList(session.change_set.artifacts).find((artifact) => artifact.type === "capability_topic")?.id;
      const answer = answers.find((item) => {
        const condition = item.resume_condition && typeof item.resume_condition === "object" && !Array.isArray(item.resume_condition)
          ? item.resume_condition as Record<string, unknown> : {};
        return condition.topic === `code_workspace:${topic}`;
      });
      const response = answer?.response && typeof answer.response === "object" && !Array.isArray(answer.response)
        ? answer.response as Record<string, unknown> : {};
      const interfaceNotes = typeof response.interface_notes === "string" ? response.interface_notes.trim() : "";
      if (!interfaceNotes) throw new Error("Code Workspaceのinterface notesがありません");
      return { ...session, interfaceNotes };
    });
  }

  private async sendPrompt(sessionId: string, prompt: string) {
    const events: AgentSessionInputParam[] = [{
      type: "agent.session.input.message",
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    }];
    await this.deps.agentsApi.forOrganization(this.organizationId).then((api) =>
      api.sendEvents(sessionId, events, `builder-session-${this.sessionId}`),
    );
    await this.deps.db.org(this.organizationId, (tx) => tx.builder_workspace_sessions.update({
      where: { id: this.sessionId },
      data: { status: "running", last_event_at: new Date() },
    }));
  }

  private async markConnected() {
    await this.deps.db.org(this.organizationId, (tx) => tx.builder_workspace_sessions.update({
      where: { id: this.sessionId },
      data: { status: "connected", last_event_at: new Date() },
    }));
  }

  private async touch() {
    await this.deps.db.org(this.organizationId, (tx) => tx.builder_workspace_sessions.update({
      where: { id: this.sessionId }, data: { last_event_at: new Date(), lease_until: new Date(Date.now() + 120_000) },
    }));
  }

  private async complete(input: BuilderWorkspaceInput) {
    const result = await this.collectResult(input);
    const body = Buffer.from(JSON.stringify(result));
    this.validateResult(result, input);
    const resultHash = sha256(body);
    await this.deps.db.org(this.organizationId, async (tx) => {
      const session = await tx.builder_workspace_sessions.findUniqueOrThrow({ where: { id: this.sessionId }, include: { change_set: true } });
      const current = artifactList(session.change_set.artifacts);
      const durable = current.filter((item) => !["commit", "base_commit", "diff", "changed_file", "builder_session"].includes(String(item.type)));
      durable.push(
        { type: "builder_session", id: session.id, name: `Session attempt ${session.attempt}` },
        { type: "base_commit", id: result.base_sha, name: result.base_sha.slice(0, 12) },
        { type: "commit", id: result.commit_sha, name: result.commit_sha.slice(0, 12) },
        { type: "diff", id: result.diff_sha256, name: result.diff_sha256.slice(0, 16) },
        ...result.changed_files.map((path) => ({ type: "changed_file", id: path, name: path })),
      );
      await tx.builder_workspace_sessions.update({ where: { id: session.id }, data: {
        status: "succeeded", result_hash: resultHash, finished_at: new Date(), lease_owner: null, lease_until: null,
      } });
      await tx.builder_change_sets.update({ where: { id: session.change_set_id }, data: {
        status: "applied", artifacts: durable as Prisma.InputJsonValue, base_sha: result.base_sha, head_sha: result.commit_sha,
      } });
      await tx.builder_validation_runs.create({ data: {
        organization_id: this.organizationId,
        project_id: session.project_id,
        suite: "builder_session",
        environment: "builder",
        status: "passed",
        evidence: {
          builder_session_id: session.id,
          runtime_id: session.runtime_id,
          change_set_id: session.change_set_id,
          base_sha: result.base_sha,
          commit_sha: result.commit_sha,
          diff_sha256: result.diff_sha256,
          changed_files: result.changed_files,
          tests: result.tests,
          result_hash: resultHash,
          source_body_returned_to_control_plane: false,
          secret_values_returned_to_control_plane: false,
        },
        finished_at: new Date(),
      } });
      const gitConnection = await tx.connections.findFirst({
        where: {
          organization_id: this.organizationId,
          status: "connected",
          revoked_at: null,
          metadata: { path: ["repository_url"], equals: input.repositoryUrl },
        },
        orderBy: { last_validated_at: "desc" },
      });
      if (gitConnection) {
        const existingJob = await tx.runtime_jobs.findFirst({
          where: { runtime_id: session.runtime_id, type: "publish_builder_branch", payload: { path: ["change_set_id"], equals: session.change_set_id }, status: { in: ["pending", "leased", "succeeded"] } },
        });
        if (!existingJob) await tx.runtime_jobs.create({ data: {
          organization_id: this.organizationId,
          runtime_id: session.runtime_id,
          type: "publish_builder_branch",
          payload: {
            type: "publish_builder_branch",
            project_id: session.project_id,
            change_set_id: session.change_set_id,
            connection_id: gitConnection.id,
            repository_url: input.repositoryUrl,
            base_branch: input.baseBranch,
            branch: input.branch,
            base_sha: result.base_sha,
            commit_sha: result.commit_sha,
          },
        } });
        await tx.human_actions.updateMany({
          where: { project_id: session.project_id, status: "pending", type: "provider_app_registration" },
          data: { status: "completed", completed_at: new Date() },
        });
        await tx.builder_projects.update({ where: { id: session.project_id }, data: { status: "running" } });
      } else {
        const existing = await tx.human_actions.findFirst({
          where: { project_id: session.project_id, status: "pending" }, select: { id: true, resume_condition: true },
        });
        const condition = existing?.resume_condition && typeof existing.resume_condition === "object" && !Array.isArray(existing.resume_condition)
          ? existing.resume_condition as Record<string, unknown> : {};
        if (condition.type !== "git_branch_published" || condition.change_set_id !== session.change_set_id) {
        await tx.human_actions.create({ data: {
          organization_id: this.organizationId,
          project_id: session.project_id,
          type: "provider_app_registration",
          title: "Git Repositoryを接続してPRを作成してください",
          reason: "Code Agentの生成、local commit、検証が完了しました。専用Provider ConnectionでbranchとPRを公開する必要があります",
          assignee_role: "admin",
          fields: [],
          instructions: ["GitHub Appを接続します", "mainへ直接pushせず、専用branchからPRを作成します"],
          resume_condition: { type: "git_branch_published", change_set_id: session.change_set_id, commit_sha: result.commit_sha, base_sha: result.base_sha },
        } });
        }
        await tx.builder_projects.update({ where: { id: session.project_id }, data: { status: "waiting_human_action" } });
      }
      await tx.audit_logs.create({ data: {
        organization_id: this.organizationId,
        actor_type: "system",
        actor_label: "Builder Session Driver",
        action: "builder.session.succeeded",
        target_type: "builder_workspace_session",
        target_id: session.id,
        result: "success",
        detail: { change_set_id: session.change_set_id, runtime_id: session.runtime_id, result_hash: resultHash, evidence_only: true },
      } });
    });
  }

  private async finish(input: BuilderWorkspaceInput): Promise<void> {
    try {
      await this.complete(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Builder成果物を検証できませんでした";
      await this.fail("builder_result", message);
    }
  }

  private async collectResult(input: BuilderWorkspaceInput): Promise<BuilderSessionResult> {
    const job = await this.deps.db.org(this.organizationId, async (tx) => {
      const existing = await tx.runtime_jobs.findFirst({
        where: {
          runtime_id: (await tx.builder_workspace_sessions.findUniqueOrThrow({ where: { id: this.sessionId } })).runtime_id,
          type: "collect_builder_session_result",
          payload: { path: ["session_id"], equals: this.sessionId },
          status: { in: ["pending", "leased", "succeeded"] },
        },
        orderBy: { created_at: "desc" },
      });
      if (existing) return existing;
      const session = await tx.builder_workspace_sessions.findUniqueOrThrow({ where: { id: this.sessionId } });
      return tx.runtime_jobs.create({ data: {
        organization_id: this.organizationId,
        runtime_id: session.runtime_id,
        type: "collect_builder_session_result",
        payload: {
          type: "collect_builder_session_result",
          session_id: this.sessionId,
          change_set_id: input.changeSetId,
        },
      } });
    });

    const deadline = Math.min(Date.now() + 60_000, (await this.load()).expires_at.getTime());
    for (;;) {
      if (this.shutdown.aborted) throw new Error("Builder結果の回収を中止しました");
      const current = await this.deps.db.org(this.organizationId, (tx) => tx.runtime_jobs.findUniqueOrThrow({ where: { id: job.id } }));
      if (current.status === "succeeded") return builderSessionResultSchema.parse(current.result);
      if (current.status === "failed" || current.status === "cancelled") {
        throw new Error(current.error ?? "Self-hosted Builder結果を回収できませんでした");
      }
      if (Date.now() >= deadline) throw new Error("Self-hosted Builder結果の回収が時間内に完了しませんでした");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  private validateResult(result: BuilderSessionResult, input: BuilderWorkspaceInput) {
    if (result.change_set_id !== input.changeSetId) throw new Error("成果物のChange Setが一致しません");
    if (result.tests.some((test) => test.status !== "passed" || test.exit_code !== 0)) throw new Error("失敗した検証が含まれています");
    const prefix = `${input.adapterPath}/`;
    if (result.changed_files.some((path) => path !== input.adapterPath && !path.startsWith(prefix))) {
      throw new Error("対象Adapter directory外の変更が含まれています");
    }
  }

  private async fail(errorClass: string, message: string, status = "failed") {
    await this.deps.db.org(this.organizationId, async (tx) => {
      const session = await tx.builder_workspace_sessions.update({ where: { id: this.sessionId }, data: {
        status, error_class: errorClass, error: message.slice(0, 1000), finished_at: new Date(), lease_owner: null, lease_until: null,
      } });
      await tx.builder_validation_runs.create({ data: {
        organization_id: this.organizationId, project_id: session.project_id, suite: "builder_session", environment: "builder",
        status: "failed", error_class: errorClass, error: message.slice(0, 1000), finished_at: new Date(),
        evidence: { builder_session_id: session.id, change_set_id: session.change_set_id, runtime_id: session.runtime_id },
      } });
      await tx.builder_projects.update({ where: { id: session.project_id }, data: { status: "failed" } });
    });
  }

  private async cleanup(apiSessionId: string) {
    const session = await this.deps.db.org(this.organizationId, (tx) => tx.builder_workspace_sessions.findUnique({ where: { id: this.sessionId } }));
    if (!session || !["succeeded", "failed", "cancelled", "expired"].includes(session.status)) return;
    const api = await this.deps.agentsApi.forOrganization(this.organizationId);
    await api.sendEvents(apiSessionId, [{ type: "agent.session.input.cancel" }]).catch(() => undefined);
    await api.deleteSession(apiSessionId);
    await this.deps.db.org(this.organizationId, (tx) => tx.runtime_jobs.create({ data: {
      organization_id: this.organizationId,
      runtime_id: session.runtime_id,
      type: "stop_session",
      payload: { type: "stop_session", session_id: session.id, reason: `Builder Session ${session.status}` },
    } }));
  }
}

export function builderPromptHash(input: BuilderWorkspaceInput): string {
  return sha256(buildBuilderSessionPrompt(input));
}

export function newBuilderSessionTokenHash(): string {
  return sha256(randomUUID());
}
