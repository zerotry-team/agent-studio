import "server-only";
import type { RuntimeProfileDto } from "@agent-studio/contracts";
import { RuntimeProfileRepository } from "@/lib/repositories";

/** 実行環境の設定（プロファイル）の一覧 */
export class ListRuntimeProfilesService {
  constructor(private readonly profiles = new RuntimeProfileRepository()) {}

  invoke(): Promise<RuntimeProfileDto[]> {
    return this.profiles.list();
  }
}
