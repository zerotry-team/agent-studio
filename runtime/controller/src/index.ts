import { readFileSync } from "node:fs";
import { redactLogText } from "@agent-studio/contracts";
import { ECSClient } from "@aws-sdk/client-ecs";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { S3Client } from "@aws-sdk/client-s3";
import { ConfigError, loadConfig, type ControllerConfig } from "./config.js";
import { Controller } from "./controller.js";
import { GrantStore } from "./grants.js";
import { createIdentitySigner } from "./identity.js";
import { DockerSessionLauncher, EcsSessionLauncher, NoopSessionLauncher, type SessionLauncher } from "./launcher.js";
import { createLogger, errorInfo, type Logger } from "./logger.js";
import { ControllerSecrets, MemorySecretStore, SecretsManagerStore } from "./secrets.js";
import { AgentStudioClient, RuntimeAuth, StudioHttp, type StudioApi } from "./studio-client.js";
import {
  DisabledBrowserLauncher,
  DockerBrowserLauncher,
  EcsBrowserLauncher,
  NoopBrowserLauncher,
  type BrowserLauncher,
} from "./browser-launcher.js";
import { DisabledWorkspaceExecutor, DockerWorkspaceExecutor, type WorkspaceExecutor } from "./workspace-executor.js";
import { DisabledGitPublisher, DockerGitPublisher } from "./git-publisher.js";
import { DisabledBuilderResultCollector, DockerBuilderResultCollector } from "./builder-result-collector.js";
import { createBrowserProfileStore } from "./browser-profile-store.js";
import { BrowserProfileBroker } from "./browser-profile-broker.js";

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function createLauncher(
  config: ControllerConfig,
  secrets: ControllerSecrets,
  studio: StudioApi,
  logger: Logger,
): SessionLauncher {
  switch (config.launcher.type) {
    case "ecs":
      return new EcsSessionLauncher(new ECSClient({ region: config.region }), config.launcher);
    case "docker":
      // ECS ではタスク定義の secrets が環境キーを注入する。docker では Controller が渡す
      return new DockerSessionLauncher(
        config.launcher,
        async () => {
          const stored = await secrets.readEnvironmentKey();
          if (stored) return stored;
          const fetched = await studio.environmentKey();
          if (fetched) await secrets.saveEnvironmentKey(fetched);
          return fetched;
        },
        logger,
      );
    case "noop":
      return new NoopSessionLauncher(logger);
  }
}

function createBrowserLauncher(config: ControllerConfig, logger: Logger): BrowserLauncher {
  switch (config.browserLauncher.type) {
    case "ecs":
      return new EcsBrowserLauncher(new ECSClient({ region: config.region }), config.browserLauncher);
    case "docker":
      return new DockerBrowserLauncher(config.browserLauncher, logger);
    case "noop":
      return new NoopBrowserLauncher();
    case "disabled":
      return new DisabledBrowserLauncher();
  }
}

function createWorkspaceExecutor(
  config: ControllerConfig,
  secrets: ControllerSecrets,
  studio: StudioApi,
  logger: Logger,
): WorkspaceExecutor {
  if (config.workspaceExecutor.type === "docker") {
    return new DockerWorkspaceExecutor(
      config.workspaceExecutor,
      {
        readEnvironmentKey: async () => {
          const stored = await secrets.readEnvironmentKey();
          if (stored) return stored;
          const fetched = await studio.environmentKey();
          if (fetched) await secrets.saveEnvironmentKey(fetched);
          return fetched;
        },
      },
      logger,
    );
  }
  return new DisabledWorkspaceExecutor();
}

async function main(): Promise<void> {
  let config: ControllerConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[runtime-controller] ${redactLogText(err.message)}`);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(config.logLevel);
  const version = readVersion();

  const store =
    config.secrets.store === "secrets-manager"
      ? new SecretsManagerStore(new SecretsManagerClient({ region: config.region }))
      : new MemorySecretStore();
  const secrets = new ControllerSecrets(store, config.secrets, logger);

  const http = new StudioHttp(config.agentStudioUrl, `agent-studio-runtime-controller/${version}`);
  const auth = new RuntimeAuth({
    http,
    signIdentity: createIdentitySigner(config),
    secrets,
    controllerVersion: version,
    logger,
  });
  const studio = new AgentStudioClient(http, auth);
  const grants = new GrantStore();
  const launcher = createLauncher(config, secrets, studio, logger);
  const browserLauncher = createBrowserLauncher(config, logger);
  const browserProfileStore = createBrowserProfileStore(
    config.browserProfileStore,
    config.browserProfileStore.type === "s3" ? new S3Client({ region: config.region }) : undefined,
  );
  const browserProfileBroker = new BrowserProfileBroker(browserLauncher, browserProfileStore, auth, config.agentStudioUrl, logger);
  const workspaceExecutor = createWorkspaceExecutor(config, secrets, studio, logger);
  const gitPublisher = config.launcher.type === "docker"
    ? new DockerGitPublisher(config.launcher.image, studio, logger, config.launcher.network)
    : new DisabledGitPublisher();
  const builderResultCollector = config.launcher.type === "docker"
    ? new DockerBuilderResultCollector(config.launcher.image, logger)
    : new DisabledBuilderResultCollector();

  logger.info(
    {
      version,
      agent_studio_url: config.agentStudioUrl,
      identity_mode: config.identity.mode,
      launcher: launcher.kind,
      browser_launcher: browserLauncher.kind,
      builder_workspace_executor: workspaceExecutor.kind,
      secret_store: config.secrets.store,
      max_concurrent_sessions: config.maxConcurrentSessions,
    },
    "設定を読み込みました",
  );

  const controller = new Controller({ config, logger, auth, studio, grants, launcher, browserLauncher, workspaceExecutor, gitPublisher, builderResultCollector, browserProfileBroker, secrets, controllerVersion: version });
  await controller.start();

  const shutdown = (signal: string) => {
    logger.info({ signal }, "停止シグナルを受け取りました");
    controller
      .stop()
      .then(() => process.exit(0))
      .catch((err) => {
        logger.error({ err: errorInfo(err) }, "停止処理に失敗しました");
        process.exit(1);
      });
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => logger.error({ err: errorInfo(reason) }, "処理されていない Promise の失敗"));
}

main().catch((err) => {
  console.error("[runtime-controller] 起動に失敗しました:", redactLogText(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
