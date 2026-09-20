import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { redactLogText } from "@agent-studio/contracts";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SSMClient } from "@aws-sdk/client-ssm";
import { ControllerAuditSink } from "./audit.js";
import { GrantResolver } from "./auth.js";
import { ToolCatalog } from "./catalog.js";
import { ConfigError, loadConfig, type GatewayConfig } from "./config.js";
import { ControllerClient } from "./controller-client.js";
import { createInternalServer, createPublicServer } from "./http-server.js";
import { executeHttpTool } from "./http-tool.js";
import { createLogger, errorMessage } from "./logger.js";
import { createSessionMcpServer } from "./mcp-server.js";
import { EnvConnectionSecrets, SecretsManagerConnectionSecrets, type ConnectionSecretProvider } from "./secrets.js";
import { ToolCallService } from "./tool-call.js";
import { loadToolConfig, ToolConfigError } from "./tool-config.js";
import { createUpstreamConnector, listUpstreamTools, UpstreamSessionPool } from "./upstream.js";

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  let config: GatewayConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[tool-gateway] ${redactLogText(err.message)}`);
      process.exit(1);
    }
    throw err;
  }
  const logger = createLogger(config.logLevel);
  const version = readVersion();

  // ツール設定が読めない・正しくないときは起動しない
  let toolConfig;
  try {
    toolConfig = await loadToolConfig({
      ...config.toolConfig,
      ssm: config.toolConfig.parameterName ? new SSMClient({ region: config.region }) : undefined,
    });
  } catch (err) {
    logger.fatal({ err: errorMessage(err) }, err instanceof ToolConfigError ? err.message : "ツール設定を読み込めませんでした");
    process.exit(1);
  }

  const secrets: ConnectionSecretProvider =
    config.secrets.source === "env"
      ? new EnvConnectionSecrets()
      : new SecretsManagerConnectionSecrets(new SecretsManagerClient({ region: config.region }), config.secrets.prefix);
  const controller = new ControllerClient(config.controllerInternalUrl);
  const connector = createUpstreamConnector({ name: "agent-studio-tool-gateway", version });
  const catalog = new ToolCatalog(toolConfig, (upstream) => listUpstreamTools(connector, upstream), logger);
  await catalog.refreshUpstreams();

  const pool = new UpstreamSessionPool(connector, logger, { idleMs: config.upstreamIdleMs });
  const audit = new ControllerAuditSink(controller, logger);
  audit.start();
  const userAgent = `agent-studio-tool-gateway/${version}`;
  const toolCalls = new ToolCallService({
    catalog,
    controller,
    audit,
    executeHttp: (tool, args) => executeHttpTool(tool, args, { secrets, userAgent }),
    upstream: pool,
    approvalWaitMs: config.approvalWaitSeconds * 1000,
    approvalPollIntervalMs: config.approvalPollIntervalMs,
    logger,
  });
  const resolver = new GrantResolver(controller);

  const publicServer = createPublicServer({
    resolver,
    createMcpServer: (grant) => createSessionMcpServer(grant, { catalog, toolCalls, version }),
    logger,
  });
  const internalServer = createInternalServer(catalog);
  await listen(publicServer, config.port, config.host);
  await listen(internalServer, config.internalPort, "127.0.0.1");
  logger.info(
    {
      version,
      port: config.port,
      internal_port: config.internalPort,
      http_tools: toolConfig.tools.length,
      upstream_mcp: toolConfig.upstream_mcp.map((u) => u.name),
      catalog: catalog.all().map((t) => t.name),
      secrets_source: config.secrets.source,
    },
    "Tool Gateway を起動しました",
  );

  const timers = [
    setInterval(() => void catalog.refreshUpstreams(), config.upstreamRefreshMs),
    setInterval(() => {
      void pool.sweep();
      toolCalls.sweepCounters();
    }, 60_000),
  ];

  const shutdown = (signal: string) => {
    logger.info({ signal }, "停止します");
    for (const t of timers) clearInterval(t);
    publicServer.close();
    internalServer.close();
    Promise.allSettled([audit.stop(), pool.closeAll()]).finally(() => process.exit(0));
    // 実行中のリクエストが終わらなくても止める
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => logger.error({ err: errorMessage(reason) }, "処理されていない Promise の失敗"));
}

main().catch((err) => {
  console.error("[tool-gateway] 起動に失敗しました:", redactLogText(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
