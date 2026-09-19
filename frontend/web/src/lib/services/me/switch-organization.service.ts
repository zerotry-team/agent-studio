import "server-only";
import { writeOrganizationCookie } from "@/lib/api/server-client";
import { MeRepository } from "@/lib/repositories";
import { InputValidationError } from "@/lib/utils/validation";
import { isUuid } from "@/lib/utils/organization";

/** 操作中の組織を切り替える（所属している組織だけ選べる） */
export class SwitchOrganizationService {
  constructor(private readonly me = new MeRepository()) {}

  async invoke(organizationId: string): Promise<{ organizationId: string }> {
    if (!isUuid(organizationId)) throw new InputValidationError({ organizationId: "組織の指定が正しくありません" });
    const me = await this.me.get();
    const membership = me.memberships.find((m) => m.organization.id === organizationId);
    if (!membership) {
      throw new InputValidationError({ organizationId: "所属していない組織は選べません" }, "所属していない組織は選べません");
    }
    writeOrganizationCookie(organizationId);
    return { organizationId };
  }
}
