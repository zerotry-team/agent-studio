import type { HumanActionDto } from "@agent-studio/contracts";
import type { Prisma, connectors, human_actions } from "@prisma/client";
import { catalogEntryFor } from "../domain/provider-catalog.js";
import type { Env } from "../env.js";
import type { ToolService } from "./tools.js";

type ConnectorForAction = Pick<connectors, "id" | "key" | "name" | "adapter" | "base_url" | "auth_type" | "provider_key" | "oauth_client_id" | "oauth_client_secret_locator">;

export type ConnectionActionContext = {
  organizationId: string;
  projectId: string;
  env: Env;
  tools: ToolService;
  /** OAuth App 未設定でも運営者がその場で登録できるようにする */
  oauthAppConfigured?: boolean;
  /** OpenAPI 検査で分かったヘッダ名（カタログ外の Connector 用） */
  headerName?: string | null;
  scopes?: string[];
};

/** Human Action の画面補助情報。Secret は入れない。 */
type Presentation = Partial<Pick<
  HumanActionDto,
  "connector_id" | "connection_id" | "oauth_start_url" | "oauth_app_configured" | "oauth_app_console_url" | "scopes" | "secret_header_name" | "mcp_server_url" | "secret_help_url" | "cli_command"
>>;

/**
 * 「連携サービス画面で接続を作ってください」ではなく、認証だけをその場で求める Human Action を作る。
 * - OAuth: 同意開始 URL を持つ `oauth_consent`
 * - API キー: Builder が Connection 枠を事前作成し、値だけを求める `enter_secret`
 * どちらも Connection の接続テスト成功で自動完了・自動再開する（BuilderProjectService.completeConnectionActions）。
 */
export async function createConnectionHumanAction(
  tx: Prisma.TransactionClient,
  ctx: ConnectionActionContext,
  connector: ConnectorForAction,
): Promise<human_actions> {
  const entry = catalogEntryFor(connector);
  const oauth = entry?.auth.kind === "oauth2" ? entry.auth : null;
  if (connector.auth_type === "runtime_secret") {
    // 値は顧客 AWS の Secrets Manager にしか置かない。Studio 側に Connection 枠や入力欄を作らない
    return tx.human_actions.create({ data: {
      organization_id: ctx.organizationId,
      project_id: ctx.projectId,
      type: "enter_secret",
      title: `${connector.name}の認証情報を貴社環境へ登録してください`,
      reason: `${connector.name}の認証情報は貴社AWSのSecrets Managerだけに保存します。Agent Studioには保存しません`,
      assignee_role: "admin",
      fields: [],
      instructions: [
        "設定 > 詳細設定 > 接続先の詳細 から、貴社Runtimeを選んで接続先を登録します",
        "認証情報の値は貴社AWSのSecrets Managerへ登録します（画面には入力しません）",
        "接続の確認が成功すると、作成を自動で再開します",
      ],
      resume_condition: { type: "connector_connected", connector_id: connector.id },
      presentation: { connector_id: connector.id, cli_command: `agent-studio runtime secret ${connector.key}` } as Prisma.InputJsonValue,
    } });
  }
  const connection = await ctx.tools.ensureManagedConnection(tx, ctx.organizationId, connector, {
    headerName: ctx.headerName ?? (entry?.auth.kind === "static_bearer" ? entry.auth.header_name : null),
    projectId: ctx.projectId,
  });
  const base = ctx.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const resumeCondition = {
    type: "connection_status",
    connector_id: connector.id,
    connection_id: connection.id,
    stage: "staging",
    status: "connected",
    ...(ctx.headerName ? { header_name: ctx.headerName } : {}),
    ...(ctx.scopes?.length ? { scopes: ctx.scopes } : {}),
  };

  if (oauth) {
    const configured = ctx.oauthAppConfigured
      ?? Boolean((connector.oauth_client_id ?? ctx.env.PROVIDER_OAUTH[entry!.key]?.client_id) && (connector.oauth_client_secret_locator ?? ctx.env.PROVIDER_OAUTH[entry!.key]?.client_secret));
    const presentation: Presentation = {
      connector_id: connector.id,
      connection_id: connection.id,
      oauth_start_url: `${base}/integrations/oauth/start?connector=${encodeURIComponent(connector.id)}&project=${encodeURIComponent(ctx.projectId)}`,
      oauth_app_configured: configured,
      oauth_app_console_url: oauth.console_url,
      scopes: ctx.scopes ?? [],
      cli_command: `agent-studio connect ${connector.provider_key ?? connector.key}`,
    };
    return tx.human_actions.create({ data: {
      organization_id: ctx.organizationId,
      project_id: ctx.projectId,
      type: "oauth_consent",
      title: `${connector.name}に接続してください`,
      reason: `${connector.name}を使うために、あなたのアカウントでの許可が必要です。必要な権限だけを要求します`,
      assignee_role: "builder",
      fields: [],
      instructions: configured
        ? ["「接続する」を押すと" + connector.name + "の画面が開きます", "許可すると自動で作成を再開します"]
        : [`${connector.name}のOAuthアプリがまだ登録されていません。運営者（オーナー）がこの画面で一度だけ登録します`, "登録後に「接続する」で許可すると自動で再開します"],
      resume_condition: resumeCondition,
      presentation: presentation as Prisma.InputJsonValue,
    } });
  }

  const help = entry?.auth.kind === "static_bearer" ? entry.auth : null;
  const presentation: Presentation = {
    connector_id: connector.id,
    connection_id: connection.id,
    secret_header_name: connection.header_name ?? undefined,
    ...(connection.scope === "openai_vault" && connector.base_url ? { mcp_server_url: connector.base_url } : {}),
    ...(help?.help_url ? { secret_help_url: help.help_url } : {}),
    cli_command: `agent-studio connect ${connector.provider_key ?? connector.key} --secret-stdin`,
  };
  return tx.human_actions.create({ data: {
    organization_id: ctx.organizationId,
    project_id: ctx.projectId,
    type: "enter_secret",
    title: `${connector.name}のAPIキーを設定してください`,
    reason: help?.secret_help ?? `${connector.name}を呼び出すための認証情報が必要です。値はAgent StudioのSecret領域だけに保存され、Agentやチャットには表示されません`,
    assignee_role: "admin",
    fields: [{ name: "secret", label: help?.secret_label ?? `${connector.name}のAPIキー`, secret: true, required: true }],
    instructions: ["値を入力して保存すると接続テストを行い、成功すると自動で作成を再開します", "チャットや他の入力欄には貼り付けないでください"],
    resume_condition: resumeCondition,
    presentation: presentation as Prisma.InputJsonValue,
  } });
}
