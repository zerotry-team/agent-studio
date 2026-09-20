"use server";

import type { CreateConnectorInput, DiscoverMcpToolsInput, SetConnectorOAuthAppInput, UpdateConnectorInput } from "@agent-studio/contracts";
import { runAction } from "@/lib/api/run-action";
import { ConnectorRepository } from "@/lib/repositories";

export async function listConnectorsAction() {
  return runAction(() => new ConnectorRepository().list(), "連携サービスを取得できませんでした");
}

export async function createConnectorAction(input: CreateConnectorInput) {
  return runAction(() => new ConnectorRepository().create(input), "連携サービスを追加できませんでした");
}

export async function updateConnectorAction(id: string, input: UpdateConnectorInput) {
  return runAction(() => new ConnectorRepository().update(id, input), "連携サービスを更新できませんでした");
}

export async function discoverMcpToolsAction(input: DiscoverMcpToolsInput) {
  return runAction(() => new ConnectorRepository().discoverMcpTools(input), "MCPサーバーの操作を取得できませんでした");
}

export async function setConnectorOAuthAppAction(id: string, input: SetConnectorOAuthAppInput) {
  return runAction(() => new ConnectorRepository().setOAuthApp(id, input), "OAuthアプリを保存できませんでした");
}
