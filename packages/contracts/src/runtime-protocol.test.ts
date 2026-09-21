import { describe, expect, it } from "vitest";
import { jobResultRequestSchema } from "./runtime-protocol.js";

describe("jobResultRequestSchema", () => {
  it("Builder Session結果のbase_shaを保持する", () => {
    const parsed = jobResultRequestSchema.parse({
      status: "succeeded",
      output: {
        change_set_id: "40000000-0000-4000-8000-000000000001",
        base_sha: "a".repeat(40),
        commit_sha: "b".repeat(40),
        diff_sha256: "c".repeat(64),
        summary: "adapterを追加しました",
        changed_files: ["integrations/company-a/index.ts"],
        tests: [{ command: "yarn test", status: "passed", exit_code: 0 }],
      },
    });
    expect(parsed.output).toHaveProperty("base_sha", "a".repeat(40));
  });
});
