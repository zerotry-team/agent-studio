import { createRuntimeSchema, inviteMemberSchema } from "@agent-studio/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { zodFieldErrors } from "./zod-ja";

describe("Japanese zod messages", () => {
  it("uses friendly Japanese messages for common errors", () => {
    const schema = z.object({ name: z.string().min(1), email: z.email(), count: z.number().int().min(1).max(10), tags: z.array(z.string()).min(1) });
    const result = schema.safeParse({ name: "", email: "x", count: 20, tags: [] });
    expect(result.success).toBe(false);
    expect(zodFieldErrors(result.error!)).toEqual({
      name: "入力してください",
      email: "メールアドレスの形式が正しくありません",
      count: "10以下の値を入力してください",
      tags: "1件以上指定してください",
    });
    expect(zodFieldErrors(schema.safeParse({}).error!).name).toBe("入力してください");
  });

  it("keeps messages defined in the contracts schemas", () => {
    const result = createRuntimeSchema.safeParse({
      name: "A社 本番",
      stage: "production",
      provisioning_type: "customer_owned",
      aws_account_id: "123",
      aws_region: "ap-northeast-1",
      expected_role_name: "as-sample-a-prod-runtime",
    });
    expect(zodFieldErrors(result.error!)).toEqual({ aws_account_id: "12桁の数字で入力してください" });
    expect(zodFieldErrors(inviteMemberSchema.safeParse({ email: "a@b.example", role: "boss" }).error!)).toEqual({
      role: "選択肢の中から選んでください",
    });
  });
});
