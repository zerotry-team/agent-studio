import {
  canonicalJson,
  policySchema,
  runtimeToolConfigSchema,
  toolCallHash,
  type ApprovalResponse,
  type Policy,
  type SessionGrant,
  type ToolAuditEvent,
} from "@agent-studio/contracts";
import { describe, expect, it, vi } from "vitest";
import { ToolCatalog } from "./catalog.js";
import { textResult, type HttpToolOutcome } from "./http-tool.js";
import { createLogger } from "./logger.js";
import { MESSAGES } from "./messages.js";
import { ToolCallService } from "./tool-call.js";

const logger = createLogger("silent");
const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const APPROVAL_ID = "50000000-0000-4000-8000-000000000001";

const approvalOver500: Policy = policySchema.parse({
  type: "approval",
  tool: "update_price",
  when: { field: "price_change", op: ">", value: 500, abs: true },
  timeout_minutes: 60,
  reason: "500 円を超える価格変更には承認が必要です",
});

const grant = (policies: Policy[] = [approvalOver500]): SessionGrant => ({
  session_id: SESSION_ID,
  run_id: "10000000-0000-4000-8000-000000000001",
  token_hash: "a".repeat(64),
  allowed_tools: ["get_product", "update_price"],
  policies,
  expires_at: "2099-01-01T00:00:00.000Z",
});

const config = runtimeToolConfigSchema.parse({
  tools: [
    {
      name: "get_product",
      description: "商品を取得します",
      risk: "read",
      input_schema: { type: "object" },
      http: { method: "GET", url: "http://demo.internal/products/{product_id}" },
    },
    {
      name: "update_price",
      description: "価格を変更します",
      risk: "financial",
      input_schema: { type: "object" },
      http: { method: "POST", url: "http://demo.internal/products/{product_id}/price" },
      policies: [
        { type: "deny", tool: "update_price", when: { field: "price_change", op: ">", value: 10000, abs: true }, reason: "Runtime 側の上限です" },
      ],
    },
    {
      name: "delete_product",
      description: "許可されていないツール",
      risk: "destructive",
      input_schema: { type: "object" },
      http: { method: "DELETE", url: "http://demo.internal/products/{product_id}" },
    },
  ],
  policies: [{ type: "rate_limit", tool: "get_product", max_calls_per_session: 2 }],
});

/** 承認 API のモック。getApproval は statuses を順に返す */
function setup(opts: { created?: ApprovalResponse["status"]; statuses?: ApprovalResponse["status"][]; approvalWaitMs?: number } = {}) {
  let t = Date.parse("2026-09-18T03:00:00Z"); // 金曜 12:00 JST
  const statuses = [...(opts.statuses ?? [])];
  const controller = {
    createApproval: vi.fn(async () => ({ approval_id: APPROVAL_ID, status: opts.created ?? ("pending" as const) })),
    getApproval: vi.fn(async () => ({ approval_id: APPROVAL_ID, status: statuses.length > 1 ? statuses.shift()! : (statuses[0] ?? "pending") })),
    consumeApproval: vi.fn(async () => ({ approval_id: APPROVAL_ID, status: "consumed" as const })),
  };
  const audits: ToolAuditEvent[] = [];
  const executeHttp = vi.fn(async (): Promise<HttpToolOutcome> => ({ result: textResult('{"ok":true}', false), auditDetail: "HTTP 200" }));
  const service = new ToolCallService({
    catalog: new ToolCatalog(config, async () => [], logger),
    controller,
    audit: { record: (e) => audits.push({ ...e, at: e.at ?? new Date(t).toISOString() }) },
    executeHttp,
    upstream: { callTool: vi.fn() },
    approvalWaitMs: opts.approvalWaitMs ?? 25_000,
    approvalPollIntervalMs: 2_000,
    logger,
    now: () => new Date(t),
    sleep: async (ms) => {
      t += ms;
    },
  });
  return { service, controller, audits, executeHttp };
}

const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

describe("ToolCallService: 許可とポリシー", () => {
  it("許可されたツールはそのまま実行し、executed を監査に残す", async () => {
    const { service, audits, executeHttp } = setup();
    const result = await service.call(grant(), "update_price", { product_id: "P-001", price_change: -400 });
    expect(result.isError).toBeUndefined();
    expect(executeHttp).toHaveBeenCalledTimes(1);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      session_id: SESSION_ID,
      tool: "update_price",
      decision: "executed",
      args_hash: await toolCallHash("update_price", { product_id: "P-001", price_change: -400 }),
    });
    expect(audits[0]!.duration_ms).toBeGreaterThanOrEqual(0);
    // 監査には引数そのものを含めない
    expect(JSON.stringify(audits)).not.toContain("P-001");
  });

  it("セッションで許可されていない・カタログに無いツールは拒否する", async () => {
    const { service, audits, executeHttp } = setup();
    const r1 = await service.call(grant(), "delete_product", { product_id: "P-001" });
    expect(r1.isError).toBe(true);
    expect(text(r1)).toBe(MESSAGES.toolNotAllowed("delete_product"));
    const r2 = await service.call({ ...grant(), allowed_tools: ["unknown_tool"] }, "unknown_tool", {});
    expect(r2.isError).toBe(true);
    expect(executeHttp).not.toHaveBeenCalled();
    expect(audits.map((a) => a.decision)).toEqual(["denied", "denied"]);
  });

  it("deny ポリシー（Runtime 側）に当たれば理由を返して実行しない", async () => {
    const { service, audits, executeHttp } = setup();
    const result = await service.call(grant(), "update_price", { product_id: "P-001", price_change: -20000 });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Runtime 側の上限です");
    expect(executeHttp).not.toHaveBeenCalled();
    expect(audits[0]).toMatchObject({ decision: "denied", detail: "Runtime 側の上限です" });
  });

  it("rate_limit は実行した回数で数える", async () => {
    const { service, executeHttp } = setup();
    await service.call(grant(), "get_product", { product_id: "P-001" });
    await service.call(grant(), "get_product", { product_id: "P-002" });
    const third = await service.call(grant(), "get_product", { product_id: "P-003" });
    expect(third.isError).toBe(true);
    expect(text(third)).toContain("2回まで");
    expect(executeHttp).toHaveBeenCalledTimes(2);
  });

  it("引数がオブジェクトでなければ拒否する", async () => {
    const { service } = setup();
    const result = await service.call(grant(), "get_product", ["P-001"]);
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(MESSAGES.invalidArguments);
  });
});

describe("ToolCallService: 承認", () => {
  const args = { product_id: "P-001", price_change: -600 };

  it("承認依頼を送り、待っている間に承認されたら消費してから実行する", async () => {
    const { service, controller, audits, executeHttp } = setup({ statuses: ["pending", "approved"] });
    const result = await service.call(grant(), "update_price", args);

    expect(result.isError).toBeUndefined();
    expect(controller.createApproval).toHaveBeenCalledWith({
      session_id: SESSION_ID,
      tool: "update_price",
      args_hash: await toolCallHash("update_price", args),
      args_preview: canonicalJson(args),
      reason: "500 円を超える価格変更には承認が必要です",
      timeout_minutes: 60,
      risk: "financial",
      destination_host: "demo.internal",
      method: "POST",
    });
    expect(controller.getApproval).toHaveBeenCalledTimes(2);
    expect(controller.consumeApproval).toHaveBeenCalledWith(APPROVAL_ID);
    expect(controller.consumeApproval.mock.invocationCallOrder[0]!).toBeLessThan(executeHttp.mock.invocationCallOrder[0]!);
    expect(audits.map((a) => a.decision)).toEqual(["executed"]);
    expect(audits[0]!.detail).toContain(APPROVAL_ID);
  });

  it("作成時点で承認済み（同じ引数の承認がある）なら待たずに実行する", async () => {
    const { service, controller, executeHttp } = setup({ created: "approved" });
    await service.call(grant(), "update_price", args);
    expect(controller.getApproval).not.toHaveBeenCalled();
    expect(controller.consumeApproval).toHaveBeenCalledTimes(1);
    expect(executeHttp).toHaveBeenCalledTimes(1);
  });

  it("却下されたら実行しない", async () => {
    const { service, audits, executeHttp } = setup({ statuses: ["denied"] });
    const result = await service.call(grant(), "update_price", args);
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(MESSAGES.approvalDenied);
    expect(executeHttp).not.toHaveBeenCalled();
    expect(audits.map((a) => a.decision)).toEqual(["denied"]);
  });

  it("待ち時間内に承認されなければ、承認 ID を伝えて終わる", async () => {
    const { service, controller, audits, executeHttp } = setup({ statuses: ["pending"], approvalWaitMs: 25_000 });
    const result = await service.call(grant(), "update_price", args);
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      `この操作には承認が必要です。承認依頼を送りました（承認ID: ${APPROVAL_ID}）。承認されたら、同じ内容でもう一度実行してください。`,
    );
    // 2 秒ごとに 25 秒まで
    expect(controller.getApproval.mock.calls.length).toBe(13);
    expect(executeHttp).not.toHaveBeenCalled();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ decision: "approval_required" });
    expect(audits[0]!.detail).toContain(APPROVAL_ID);
  });

  it("期限切れ", async () => {
    const { service } = setup({ statuses: ["expired"] });
    const result = await service.call(grant(), "update_price", args);
    expect(text(result)).toBe(MESSAGES.approvalExpired);
  });

  it("承認の消費に失敗したら実行しない", async () => {
    const { service, controller, executeHttp } = setup({ created: "approved" });
    controller.consumeApproval.mockRejectedValueOnce(new Error("conflict"));
    const result = await service.call(grant(), "update_price", args);
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(MESSAGES.approvalUnavailable);
    expect(executeHttp).not.toHaveBeenCalled();
  });

  it("消費の時点で期限切れなら、期限切れとして返す", async () => {
    const { service, controller, executeHttp } = setup({ created: "approved" });
    controller.consumeApproval.mockResolvedValueOnce({ approval_id: APPROVAL_ID, status: "expired" } as never);
    const result = await service.call(grant(), "update_price", args);
    expect(text(result)).toBe(MESSAGES.approvalExpired);
    expect(executeHttp).not.toHaveBeenCalled();
  });

  it("承認が不要な金額なら承認依頼を送らない", async () => {
    const { service, controller } = setup();
    await service.call(grant(), "update_price", { product_id: "P-001", price_change: -400 });
    expect(controller.createApproval).not.toHaveBeenCalled();
  });
});

describe("ToolCallService: Run専用Browser endpoint", () => {
  it("Session Grantのendpointへだけルーティングし、Profile modeではexec_jsを隠す", async () => {
    const dynamicConfig = runtimeToolConfigSchema.parse({
      upstream_mcp: [
        {
          name: "browser",
          url: "http://browser-session.invalid/mcp",
          dynamic_session_endpoint: "browser",
          tools: [
            { name: "browser_snapshot", description: "snapshot", input_schema: { type: "object" }, risk: "read", reads_untrusted_content: true },
            { name: "browser_exec_js", description: "exec", input_schema: { type: "object" }, risk: "write", reads_untrusted_content: true },
          ],
        },
      ],
    });
    const catalog = new ToolCatalog(dynamicConfig, async () => {
      throw new Error("動的endpointは起動前に問い合わせない");
    }, logger);
    await catalog.refreshUpstreams();
    const upstream = { callTool: vi.fn(async () => textResult("ok", false)) };
    const service = new ToolCallService({
      catalog,
      controller: { createApproval: vi.fn(), getApproval: vi.fn(), consumeApproval: vi.fn() },
      audit: { record: vi.fn() },
      executeHttp: vi.fn(),
      upstream,
      approvalWaitMs: 0,
      approvalPollIntervalMs: 1,
      logger,
    });
    const publicGrant: SessionGrant = {
      ...grant([]),
      allowed_tools: ["browser_snapshot", "browser_exec_js"],
      browser: { endpoint: "http://10.40.1.25:8931/mcp/run-token", mode: "public_ephemeral", allow_public_web: false, allowed_domains: ["example.com"] },
    };
    expect(catalog.visibleFor(publicGrant).map((tool) => tool.name)).toEqual(["browser_snapshot", "browser_exec_js"]);
    await service.call(publicGrant, "browser_snapshot", {});
    expect(upstream.callTool).toHaveBeenCalledWith(
      publicGrant,
      expect.objectContaining({ url: publicGrant.browser!.endpoint }),
      "browser_snapshot",
      {},
    );

    const authenticated = { ...publicGrant, browser: { ...publicGrant.browser!, mode: "authenticated_restricted" as const } };
    expect(catalog.visibleFor(authenticated).map((tool) => tool.name)).toEqual(["browser_snapshot"]);
  });

  it("browser_uploadはpolicy欠落時もGatewayが承認を強制し、承認消費後だけ実行する", async () => {
    const dynamicConfig = runtimeToolConfigSchema.parse({
      upstream_mcp: [{
        name: "browser", url: "http://browser-session.invalid/mcp", dynamic_session_endpoint: "browser",
        tools: [{ name: "browser_upload", description: "upload", input_schema: { type: "object" }, risk: "external_send", reads_untrusted_content: true }],
      }],
    });
    const catalog = new ToolCatalog(dynamicConfig, async () => [], logger);
    await catalog.refreshUpstreams();
    const upstream = { callTool: vi.fn(async () => textResult("uploaded", false)) };
    const controller = {
      createApproval: vi.fn(async () => ({ approval_id: APPROVAL_ID, status: "approved" as const })),
      getApproval: vi.fn(),
      consumeApproval: vi.fn(async () => ({ approval_id: APPROVAL_ID, status: "consumed" as const })),
    };
    const service = new ToolCallService({
      catalog, controller, audit: { record: vi.fn() }, executeHttp: vi.fn(), upstream,
      approvalWaitMs: 0, approvalPollIntervalMs: 1, logger,
    });
    const browserGrant: SessionGrant = {
      ...grant([]),
      allowed_tools: ["browser_upload"],
      browser: { endpoint: "http://10.40.1.25:8931/mcp/run-token", mode: "authenticated_restricted", allow_public_web: false, allowed_domains: ["example.com"] },
    };
    const args = { selector: "#file", artifact_id: "artifact-1", destination: "https://example.com/upload", filename: "report.csv", sha256: "a".repeat(64) };
    await service.call(browserGrant, "browser_upload", args);
    expect(controller.createApproval).toHaveBeenCalledWith(expect.objectContaining({
      tool: "browser_upload", args_preview: canonicalJson(args), risk: "external_send",
      reason: "外部への送信には実行直前の承認が必要です",
    }));
    expect(controller.consumeApproval.mock.invocationCallOrder[0]!).toBeLessThan(upstream.callTool.mock.invocationCallOrder[0]!);
    expect(upstream.callTool).toHaveBeenCalledTimes(1);
  });
});
