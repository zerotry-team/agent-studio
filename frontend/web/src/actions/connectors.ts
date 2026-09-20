"use server";

import type { CreateConnectorInput } from "@agent-studio/contracts";
import { runAction } from "@/lib/api/run-action";
import { ConnectorRepository } from "@/lib/repositories";

export async function listConnectorsAction() {
  return runAction(() => new ConnectorRepository().list(), "連携サービスを取得できませんでした");
}

export async function createConnectorAction(input: CreateConnectorInput) {
  return runAction(() => new ConnectorRepository().create(input), "連携サービスを追加できませんでした");
}
