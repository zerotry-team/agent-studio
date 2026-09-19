import "server-only";
import { inviteMemberSchema, type InviteMemberInput, type MemberDto } from "@agent-studio/contracts";
import { MemberRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

export class InviteMemberService {
  constructor(private readonly members = new MemberRepository()) {}

  invoke(input: InviteMemberInput): Promise<MemberDto> {
    return this.members.invite(parseInput(inviteMemberSchema, input));
  }
}
