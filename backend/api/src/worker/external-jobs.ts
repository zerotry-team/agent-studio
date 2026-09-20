export type ExternalJobStatus = "pending" | "processing" | "succeeded" | "failed" | "unknown";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseExternalJobResponse(output: string): {
  providerJobId: string | null;
  status: ExternalJobStatus;
  response: Record<string, unknown>;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  const root = record(parsed);
  if (!root) return null;
  const data = record(root.data);
  const job = record(root.job);
  const candidate = job ?? data ?? root;
  const idValue = candidate.job_id ?? candidate.jobId ?? candidate.id ?? root.job_id ?? root.jobId;
  const providerJobId = typeof idValue === "string" || typeof idValue === "number" ? String(idValue) : null;
  const raw = String(candidate.status ?? root.status ?? "pending").toLowerCase();
  const status: ExternalJobStatus =
    ["succeeded", "success", "completed", "done"].includes(raw) ? "succeeded" :
      ["failed", "error", "cancelled", "canceled"].includes(raw) ? "failed" :
        ["processing", "running", "in_progress", "working"].includes(raw) ? "processing" :
          ["pending", "queued", "accepted", "created"].includes(raw) ? "pending" : "unknown";
  return { providerJobId, status, response: root };
}
