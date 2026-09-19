import "server-only";
import type { MemberDto, UpdateMemberInput } from "@agent-studio/contracts";
import { ApiRepository } from "./base";

export class MemberRepository extends ApiRepository {
  list(): Promise<MemberDto[]> {
    return this.api.get<MemberDto[]>("/members");
  }

  invite(input: { email: string; role: MemberDto["role"]; is_approver: boolean }): Promise<MemberDto> {
    return this.api.post<MemberDto>("/members", input);
  }

  update(userId: string, input: UpdateMemberInput): Promise<MemberDto> {
    return this.api.patch<MemberDto>(`/members/${encodeURIComponent(userId)}`, input);
  }

  remove(userId: string): Promise<void> {
    return this.api.delete(`/members/${encodeURIComponent(userId)}`);
  }
}
