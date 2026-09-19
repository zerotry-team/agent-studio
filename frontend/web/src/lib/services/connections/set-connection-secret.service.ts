import "server-only";
import { setConnectionSecretSchema, type SetConnectionSecretInput } from "@agent-studio/contracts";
import { ConnectionRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

/** 認証情報の値を設定する（書き込み専用。値は保存後に表示しない） */
export class SetConnectionSecretService {
  constructor(private readonly connections = new ConnectionRepository()) {}

  invoke(connectionId: string, input: SetConnectionSecretInput): Promise<void> {
    const payload = parseInput(setConnectionSecretSchema, {
      ...input,
      mcp_server_url: input.mcp_server_url?.trim() || undefined,
    });
    return this.connections.setSecret(connectionId, payload);
  }
}
