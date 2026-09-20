import { describe, expect, it } from "vitest";
import { parseExternalJobResponse } from "./external-jobs.js";

describe("parseExternalJobResponse", () => {
  it("accepts a nested Social Router job response", () => {
    expect(parseExternalJobResponse(JSON.stringify({ job: { id: "job-123", status: "queued" } }))).toMatchObject({
      providerJobId: "job-123",
      status: "pending",
    });
  });

  it("normalizes terminal statuses", () => {
    expect(parseExternalJobResponse(JSON.stringify({ data: { job_id: "job-456", status: "completed" } }))).toMatchObject({
      providerJobId: "job-456",
      status: "succeeded",
    });
    expect(parseExternalJobResponse(JSON.stringify({ id: "job-789", status: "error" }))).toMatchObject({
      providerJobId: "job-789",
      status: "failed",
    });
  });

  it("does not infer a job from non-JSON output", () => {
    expect(parseExternalJobResponse("accepted")).toBeNull();
  });
});
