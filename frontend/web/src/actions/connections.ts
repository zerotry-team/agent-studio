"use server";

import type { CreateConnectionInput, SetConnectionSecretInput } from "@agent-studio/contracts";
import { runAction } from "@/lib/api/run-action";
import { ConnectionRepository } from "@/lib/repositories";
import {
  CreateConnectionService,
  DeleteConnectionService,
  ListConnectionsService,
  SetConnectionSecretService,
} from "@/lib/services/connections";

export async function listConnectionsAction() {
  return runAction(() => new ListConnectionsService().invoke(), "接続先の一覧を取得できませんでした");
}

export async function createConnectionAction(input: CreateConnectionInput) {
  return runAction(() => new CreateConnectionService().invoke(input), "接続先を登録できませんでした");
}

/** 認証情報の値は書き込み専用。戻り値に値は含まれない */
export async function setConnectionSecretAction(connectionId: string, input: SetConnectionSecretInput) {
  return runAction(() => new SetConnectionSecretService().invoke(connectionId, input), "認証情報を保存できませんでした");
}

export async function deleteConnectionAction(connectionId: string) {
  return runAction(() => new DeleteConnectionService().invoke(connectionId), "接続先を削除できませんでした");
}

export async function validateConnectionAction(connectionId: string) {
  return runAction(() => new ConnectionRepository().validate(connectionId), "Connectionを確認できませんでした");
}

export async function revokeConnectionAction(connectionId: string) {
  return runAction(() => new ConnectionRepository().revoke(connectionId), "Connectionを失効できませんでした");
}
