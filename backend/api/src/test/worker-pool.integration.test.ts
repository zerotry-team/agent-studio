import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

describe("Worker pool isolation", () => {
  let first: Harness;
  let second: Harness;

  beforeAll(() => {
    first = createHarness();
    second = createHarness();
  });

  afterAll(async () => {
    await Promise.all([first.close(), second.close()]);
  });

  it("通常Workerと別HarnessのWorkerがBuilder Jobをclaimしない", async () => {
    const firstEmail = "worker-pool-first@example.com";
    const secondEmail = "worker-pool-second@example.com";
    const [firstOrg, secondOrg] = await Promise.all([
      first.createOrg("worker-pool-first", [{ email: firstEmail, role: "builder" }]),
      second.createOrg("worker-pool-second", [{ email: secondEmail, role: "builder" }]),
    ]);
    await Promise.all([
      first.request("POST", "/api/v1/builder-projects", {
        email: firstEmail,
        org: firstOrg.id,
        body: { request: "文章を分類するAgentを作成してください" },
      }),
      second.request("POST", "/api/v1/builder-projects", {
        email: secondEmail,
        org: secondOrg.id,
        body: { request: "文章を要約するAgentを作成してください" },
      }),
    ]);

    const production = await first.deps.system.claimBuilderRuns("dev-worker", 60, 10);
    expect(production).toEqual([]);

    const firstClaims = await first.deps.system.claimBuilderRuns(first.env.WORKER_ID, 60, 10);
    const secondClaims = await second.deps.system.claimBuilderRuns(second.env.WORKER_ID, 60, 10);
    expect(firstClaims.map((item) => item.organization_id)).toEqual([firstOrg.id]);
    expect(secondClaims.map((item) => item.organization_id)).toEqual([secondOrg.id]);
  });
});
