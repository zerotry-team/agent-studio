import "server-only";
import { MemberRepository } from "@/lib/repositories";

export class RemoveMemberService {
  constructor(private readonly members = new MemberRepository()) {}

  invoke(userId: string): Promise<void> {
    return this.members.remove(userId);
  }
}
