import "server-only";
import type { MeDto } from "@agent-studio/contracts";
import { MeRepository } from "@/lib/repositories";

/** ログイン中のユーザーと所属組織を取得する */
export class GetCurrentUserService {
  constructor(private readonly me = new MeRepository()) {}

  invoke(): Promise<MeDto> {
    return this.me.get();
  }
}
