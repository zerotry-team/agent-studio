import "server-only";
import type { UsageDto } from "@agent-studio/contracts";
import { UsageRepository } from "@/lib/repositories";
import { InputValidationError } from "@/lib/utils/validation";

export class GetUsageService {
  constructor(private readonly usage = new UsageRepository()) {}

  invoke(month?: string): Promise<UsageDto> {
    if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new InputValidationError({ month: "年月は YYYY-MM の形式で指定してください" });
    }
    return this.usage.get(month);
  }
}
