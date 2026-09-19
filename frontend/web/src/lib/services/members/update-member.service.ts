import "server-only";
import { updateMemberSchema, type MemberDto, type UpdateMemberInput } from "@agent-studio/contracts";
import { MemberRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

export class UpdateMemberService {
  constructor(private readonly members = new MemberRepository()) {}

  invoke(userId: string, input: UpdateMemberInput): Promise<MemberDto> {
    return this.members.update(userId, parseInput(updateMemberSchema, input));
  }
}
