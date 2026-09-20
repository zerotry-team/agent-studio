import {
  approvalDecisionSchema,
  createAgentSchema,
  createAgentProjectSchema,
  createAgentScheduleSchema,
  createAgentVersionSchema,
  createConnectionSchema,
  createConnectorSchema,
  discoverMcpToolsSchema,
  exchangeQiitaOAuthSchema,
  setBrowserAccessSchema,
  updateConnectorSchema,
  createDeploymentSchema,
  createEvalCaseSchema,
  createOrganizationSchema,
  createPolicySchema,
  createRunSchema,
  createRuntimeProfileSchema,
  createRuntimeSchema,
  createToolInputSchema,
  createToolVersionSchema,
  createWorkflowSchema,
  generateManifestSchema,
  inviteMemberSchema,
  isBrowserAccessConfigured,
  linkAgentConnectionSchema,
  listQuerySchema,
  sendRunMessageSchema,
  setConnectionSecretSchema,
  setConnectorOAuthAppSchema,
  setAgentEnvironmentSchema,
  setOpenAiCredentialsSchema,
  startEvalRunSchema,
  startWorkflowRunSchema,
  updateMemberSchema,
  updateOrganizationSchema,
  updatePolicySchema,
  updateWorkflowSchema,
  updateAgentScheduleSchema,
  usesBrowserCapability,
} from "@agent-studio/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Deps } from "../application/deps.js";
import type { Services } from "../container.js";
import { AppError } from "../domain/errors.js";
import { requireMember, requireUser, type AppEnv } from "./middleware.js";

const uuidParam = z.uuid({ message: "ID の形式が正しくありません" });

/** 利用者向け API（/api/v1）。docs/architecture/api.md と対応させる */
export function createApiRoutes(deps: Deps, s: Services) {
  const app = new Hono<AppEnv>();
  app.use("*", bodyLimit({ maxSize: 1024 * 1024, onError: () => { throw new AppError("payload_too_large", 400, "送信内容が大きすぎます"); } }));
  app.use("*", requireUser(deps));

  const json = async <T extends z.ZodType>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> =>
    schema.parse(await c.req.json());
  const id = (v: string | undefined) => uuidParam.parse(v);
  const readyForPreview = (agent: {
    capability_resolution: { ready: boolean; selected_tools: string[] };
    browser_access: "restricted" | "public";
    browser_allowed_domains: string[];
  }) =>
    agent.capability_resolution.ready &&
    (!usesBrowserCapability(agent.capability_resolution) ||
      isBrowserAccessConfigured(agent.browser_access, agent.browser_allowed_domains));

  // ---- 組織を選ばない操作 ----
  app.get("/me", async (c) => c.json(await s.organizations.me(c.get("user"))));
  app.post("/admin/organizations", async (c) =>
    c.json(await s.organizations.create(c.get("user"), await json(c, createOrganizationSchema)), 201),
  );

  // ---- 以降は組織を選んだ操作 ----
  const org = new Hono<AppEnv>();
  org.use("*", requireMember(deps));

  org.get("/organization", async (c) => c.json(await s.organizations.get(c.get("member"))));
  org.patch("/organization", async (c) => c.json(await s.organizations.update(c.get("member"), await json(c, updateOrganizationSchema))));
  org.get("/organization/openai", async (c) => c.json(await s.organizations.getOpenAiSettings(c.get("member"))));
  org.put("/organization/openai", async (c) =>
    c.json(await s.organizations.setOpenAiSettings(c.get("member"), await json(c, setOpenAiCredentialsSchema))),
  );

  org.get("/members", async (c) => c.json(await s.organizations.listMembers(c.get("member"))));
  org.post("/members", async (c) => c.json(await s.organizations.inviteMember(c.get("member"), await json(c, inviteMemberSchema)), 201));
  org.patch("/members/:userId", async (c) =>
    c.json(await s.organizations.updateMember(c.get("member"), id(c.req.param("userId")), await json(c, updateMemberSchema))),
  );
  org.delete("/members/:userId", async (c) => {
    await s.organizations.removeMember(c.get("member"), id(c.req.param("userId")));
    return c.body(null, 204);
  });

  org.get("/policies", async (c) => c.json(await s.organizations.listPolicies(c.get("member"))));
  org.post("/policies", async (c) => c.json(await s.organizations.createPolicy(c.get("member"), await json(c, createPolicySchema)), 201));
  org.patch("/policies/:id", async (c) =>
    c.json(await s.organizations.updatePolicy(c.get("member"), id(c.req.param("id")), await json(c, updatePolicySchema))),
  );
  org.delete("/policies/:id", async (c) => {
    await s.organizations.deletePolicy(c.get("member"), id(c.req.param("id")));
    return c.body(null, 204);
  });

  org.get("/tools", async (c) => c.json(await s.tools.list(c.get("member"))));
  org.post("/tools", async (c) => c.json(await s.tools.create(c.get("member"), await json(c, createToolInputSchema)), 201));
  org.get("/tools/:id", async (c) => c.json(await s.tools.get(c.get("member"), id(c.req.param("id")))));
  org.post("/tools/:id/versions", async (c) =>
    c.json(await s.tools.addVersion(c.get("member"), id(c.req.param("id")), await json(c, createToolVersionSchema)), 201),
  );

  org.get("/connectors", async (c) => c.json(await s.tools.listConnectors(c.get("member"))));
  org.post("/connectors", async (c) => c.json(await s.tools.createConnector(c.get("member"), await json(c, createConnectorSchema)), 201));
  org.post("/connectors/discover", async (c) => c.json(await s.tools.discoverMcpTools(c.get("member"), await json(c, discoverMcpToolsSchema))));
  org.patch("/connectors/:id", async (c) =>
    c.json(await s.tools.updateConnector(c.get("member"), id(c.req.param("id")), await json(c, updateConnectorSchema))),
  );
  org.get("/connectors/:id", async (c) => c.json(await s.tools.getConnector(c.get("member"), id(c.req.param("id")))));
  org.get("/connectors/:id/oauth-app", async (c) =>
    c.json(await s.tools.getConnectorOAuthApp(c.get("member"), id(c.req.param("id")))),
  );
  org.put("/connectors/:id/oauth-app", async (c) =>
    c.json(
      await s.tools.setConnectorOAuthApp(
        c.get("member"),
        id(c.req.param("id")),
        await json(c, setConnectorOAuthAppSchema),
      ),
    ),
  );

  org.get("/connections", async (c) => c.json(await s.tools.listConnections(c.get("member"))));
  org.post("/connections", async (c) => c.json(await s.tools.createConnection(c.get("member"), await json(c, createConnectionSchema)), 201));
  org.post("/connectors/:id/qiita-oauth/exchange", async (c) => {
    const input = await json(c, exchangeQiitaOAuthSchema);
    return c.json(await s.tools.exchangeQiitaOAuth(c.get("member"), id(c.req.param("id")), input.code), 201);
  });
  org.put("/connections/:id/secret", async (c) => {
    await s.tools.setConnectionSecret(c.get("member"), id(c.req.param("id")), await json(c, setConnectionSecretSchema));
    return c.body(null, 204);
  });
  org.post("/connections/:id/validate", async (c) =>
    c.json(await s.tools.validateConnection(c.get("member"), id(c.req.param("id")))),
  );
  org.post("/connections/:id/revoke", async (c) =>
    c.json(await s.tools.revokeConnection(c.get("member"), id(c.req.param("id")))),
  );
  org.delete("/connections/:id", async (c) => {
    await s.tools.deleteConnection(c.get("member"), id(c.req.param("id")));
    return c.body(null, 204);
  });

  org.get("/agents", async (c) => c.json(await s.agents.list(c.get("member"))));
  org.get("/agents/:id/schedules", async (c) => c.json(await s.schedules.list(c.get("member"), id(c.req.param("id")))));
  org.post("/agents/:id/schedules", async (c) =>
    c.json(await s.schedules.create(c.get("member"), id(c.req.param("id")), await json(c, createAgentScheduleSchema)), 201),
  );
  org.patch("/schedules/:id", async (c) =>
    c.json(await s.schedules.update(c.get("member"), id(c.req.param("id")), await json(c, updateAgentScheduleSchema))),
  );
  org.delete("/schedules/:id", async (c) => {
    await s.schedules.delete(c.get("member"), id(c.req.param("id")));
    return c.body(null, 204);
  });
  org.post("/agent-projects", async (c) => {
    const actor = c.get("member");
    const input = await json(c, createAgentProjectSchema);
    const agent = await s.agents.createProject(actor, input.description);
    let autoPreviewCreated = false;
    if (readyForPreview(agent)) {
      try {
        await s.environments.createPreview(actor, agent.id);
        autoPreviewCreated = true;
      } catch (error) {
        deps.logger.warn({ err: error, agent_id: agent.id }, "Agent Project作成後のPreview自動作成を保留しました");
      }
    }
    return c.json({ ...(await s.agents.getProject(actor, agent.id)), auto_preview_created: autoPreviewCreated }, 201);
  });
  org.post("/agents", async (c) => c.json(await s.agents.create(c.get("member"), (await json(c, createAgentSchema)).manifest), 201));
  org.post("/agents/generate", async (c) =>
    c.json(await s.agents.generate(c.get("member"), (await json(c, generateManifestSchema)).description)),
  );
  org.post("/agents/validate", async (c) => c.json(await s.agents.validate(c.get("member"), (await json(c, createAgentSchema)).manifest)));
  org.get("/agents/:id", async (c) => c.json(await s.agents.get(c.get("member"), id(c.req.param("id")))));
  org.put("/agents/:id/browser-access", async (c) =>
    c.json(await s.agents.setBrowserAccess(c.get("member"), id(c.req.param("id")), await json(c, setBrowserAccessSchema))),
  );
  org.get("/agents/:id/project", async (c) => c.json(await s.agents.getProject(c.get("member"), id(c.req.param("id")))));
  org.put("/agents/:id/connections", async (c) => {
    const actor = c.get("member");
    const agentId = id(c.req.param("id"));
    const project = await s.agents.linkConnection(actor, agentId, await json(c, linkAgentConnectionSchema));
    const hasPreview = project.deployments.some((deployment) => deployment.stage === "staging" && deployment.status === "active");
    if (readyForPreview(project.agent) && !hasPreview) await s.environments.createPreview(actor, agentId);
    return c.json(await s.agents.getProject(actor, agentId));
  });
  org.put("/agents/:id/environment", async (c) => {
    const actor = c.get("member");
    const agentId = id(c.req.param("id"));
    const project = await s.agents.setEnvironment(actor, agentId, await json(c, setAgentEnvironmentSchema));
    const hasPreview = project.deployments.some((deployment) => deployment.stage === "staging" && deployment.status === "active");
    if (readyForPreview(project.agent) && !hasPreview) await s.environments.createPreview(actor, agentId);
    return c.json(await s.agents.getProject(actor, agentId));
  });
  org.post("/agents/:id/preview", async (c) => c.json(await s.environments.createPreview(c.get("member"), id(c.req.param("id"))), 201));
  org.post("/agents/:id/invoke", async (c) => {
    const stage = z.enum(["staging", "production"]).default("staging").parse(c.req.query("stage"));
    const input = await json(c, z.object({ input: z.string().trim().min(1).max(100_000) }).strict());
    return c.json(await s.runs.createForAgent(c.get("member"), id(c.req.param("id")), stage, input.input), 201);
  });
  org.post("/agents/:id/versions", async (c) =>
    c.json(await s.agents.createVersion(c.get("member"), id(c.req.param("id")), (await json(c, createAgentVersionSchema)).manifest), 201),
  );
  org.post("/agents/:id/versions/:version/publish", async (c) =>
    c.json(await s.agents.publish(c.get("member"), id(c.req.param("id")), z.coerce.number().int().min(1).parse(c.req.param("version")))),
  );
  org.get("/agents/:id/eval-cases", async (c) => c.json(await s.agents.listEvalCases(c.get("member"), id(c.req.param("id")))));
  org.post("/agents/:id/eval-cases", async (c) =>
    c.json(await s.agents.createEvalCase(c.get("member"), id(c.req.param("id")), await json(c, createEvalCaseSchema)), 201),
  );
  org.delete("/eval-cases/:id", async (c) => {
    await s.agents.deleteEvalCase(c.get("member"), id(c.req.param("id")));
    return c.body(null, 204);
  });
  org.get("/agents/:id/eval-runs", async (c) => c.json(await s.agents.listEvalRuns(c.get("member"), id(c.req.param("id")))));
  org.post("/agents/:id/eval-runs", async (c) =>
    c.json(await s.agents.startEvalRun(c.get("member"), id(c.req.param("id")), (await json(c, startEvalRunSchema)).deployment_id), 201),
  );

  org.get("/environments", async (c) => c.json(await s.environments.listProfiles(c.get("member"))));
  org.post("/environments", async (c) =>
    c.json(await s.environments.createProfile(c.get("member"), await json(c, createRuntimeProfileSchema)), 201),
  );
  org.delete("/environments/:id", async (c) => {
    await s.environments.deleteProfile(c.get("member"), id(c.req.param("id")));
    return c.body(null, 204);
  });

  org.get("/runtimes", async (c) => c.json(await s.environments.listRuntimes(c.get("member"))));
  org.post("/runtimes", async (c) => c.json(await s.environments.createRuntime(c.get("member"), await json(c, createRuntimeSchema)), 201));
  org.get("/runtimes/:id", async (c) => c.json(await s.environments.getRuntime(c.get("member"), id(c.req.param("id")))));
  org.post("/runtimes/:id/bootstrap-tokens", async (c) =>
    c.json(await s.environments.issueBootstrapToken(c.get("member"), id(c.req.param("id"))), 201),
  );
  org.post("/runtimes/:id/revoke", async (c) => c.json(await s.environments.revokeRuntime(c.get("member"), id(c.req.param("id")))));
  org.post("/runtimes/:id/rotate-environment-key", async (c) => {
    await s.environments.rotateEnvironmentKey(c.get("member"), id(c.req.param("id")));
    return c.body(null, 202);
  });

  org.get("/deployments", async (c) => {
    const agentId = c.req.query("agent_id");
    return c.json(await s.environments.listDeployments(c.get("member"), agentId ? id(agentId) : undefined));
  });
  org.post("/deployments", async (c) =>
    c.json(await s.environments.createDeployment(c.get("member"), await json(c, createDeploymentSchema)), 201),
  );
  org.post("/deployments/:id/archive", async (c) => c.json(await s.environments.archiveDeployment(c.get("member"), id(c.req.param("id")))));
  org.post("/deployments/:id/promote", async (c) => c.json(await s.environments.promote(c.get("member"), id(c.req.param("id"))), 201));
  org.post("/deployments/:id/rollback", async (c) => c.json(await s.environments.rollback(c.get("member"), id(c.req.param("id"))), 201));

  org.get("/runs", async (c) => {
    const q = listQuerySchema.parse(c.req.query());
    const deploymentId = c.req.query("deployment_id");
    return c.json(
      await s.runs.list(c.get("member"), {
        limit: q.limit,
        ...(q.before ? { before: q.before } : {}),
        ...(deploymentId ? { deployment_id: id(deploymentId) } : {}),
      }),
    );
  });
  org.post("/runs", async (c) => c.json(await s.runs.create(c.get("member"), await json(c, createRunSchema)), 201));
  org.get("/runs/:id", async (c) => c.json(await s.runs.get(c.get("member"), id(c.req.param("id")))));
  org.get("/runs/:id/events", async (c) =>
    c.json(await s.runs.events(c.get("member"), id(c.req.param("id")), z.coerce.number().int().min(0).default(0).parse(c.req.query("after_seq")))),
  );
  org.get("/runs/:id/artifacts", async (c) => c.json(await s.runs.artifacts(c.get("member"), id(c.req.param("id")))));
  org.post("/runs/:id/messages", async (c) => {
    await s.runs.sendMessage(c.get("member"), id(c.req.param("id")), (await json(c, sendRunMessageSchema)).input);
    return c.body(null, 202);
  });
  org.post("/runs/:id/cancel", async (c) => c.json(await s.runs.cancel(c.get("member"), id(c.req.param("id")))));

  org.get("/approvals", async (c) => {
    const status = z.enum(["pending", "approved", "denied", "expired", "consumed"]).optional().parse(c.req.query("status"));
    return c.json(await s.runs.listApprovals(c.get("member"), status));
  });
  org.post("/approvals/:id/decision", async (c) =>
    c.json(await s.runs.decide(c.get("member"), id(c.req.param("id")), await json(c, approvalDecisionSchema))),
  );

  org.get("/workflows", async (c) => c.json(await s.workflows.list(c.get("member"))));
  org.post("/workflows", async (c) => c.json(await s.workflows.create(c.get("member"), await json(c, createWorkflowSchema)), 201));
  org.get("/workflows/:id", async (c) => c.json(await s.workflows.get(c.get("member"), id(c.req.param("id")))));
  org.put("/workflows/:id", async (c) =>
    c.json(await s.workflows.update(c.get("member"), id(c.req.param("id")), await json(c, updateWorkflowSchema))),
  );
  org.post("/workflows/:id/runs", async (c) =>
    c.json(await s.workflows.start(c.get("member"), id(c.req.param("id")), (await json(c, startWorkflowRunSchema)).input), 201),
  );
  org.get("/workflow-runs", async (c) => {
    const workflowId = c.req.query("workflow_id");
    return c.json(await s.workflows.listRuns(c.get("member"), workflowId ? id(workflowId) : undefined));
  });
  org.get("/workflow-runs/:id", async (c) => c.json(await s.workflows.getRun(c.get("member"), id(c.req.param("id")))));

  org.get("/audit-logs", async (c) => {
    const q = listQuerySchema.parse(c.req.query());
    return c.json(await s.insights.auditLogs(c.get("member"), { limit: q.limit, ...(q.before ? { before: q.before } : {}) }));
  });
  org.get("/usage", async (c) => {
    const month = c.req.query("month") ?? new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7);
    return c.json(await s.insights.usage(c.get("member"), month));
  });

  app.route("/", org);
  return app;
}
