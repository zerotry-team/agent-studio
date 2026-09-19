import "server-only";
import type { MemberDto } from "@agent-studio/contracts";
import { MemberRepository } from "@/lib/repositories";

export class ListMembersService {
  constructor(private readonly members = new MemberRepository()) {}

  invoke(): Promise<MemberDto[]> {
    return this.members.list();
  }
}
