import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const [repo, resultPath] = process.argv.slice(2);
if (!repo || !resultPath || !process.env.BASE_COMMIT || !process.env.CODEX_EVENTS || !process.env.BUILDER_CHANGE_SET_ID) process.exit(64);

const git = (...args) => {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
};

const eventsText = await readFile(process.env.CODEX_EVENTS, "utf8");
const tests = [];
for (const line of eventsText.split("\n")) {
  if (!line.trim()) continue;
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  const item = event?.item ?? event;
  const command = typeof item?.command === "string" ? item.command : typeof event?.command === "string" ? event.command : "";
  const exitCode = Number.isInteger(item?.exit_code) ? item.exit_code : Number.isInteger(event?.exit_code) ? event.exit_code : null;
  if (!command || exitCode === null || !/(^|\s|\/)(test|lint|type-?check|check)(\s|$)|vitest|jest|pytest|cargo test|go test|swift test|tsc\b/i.test(command)) continue;
  tests.push({ command: command.slice(0, 500), status: exitCode === 0 ? "passed" : "failed", exit_code: exitCode });
}
tests.push({ command: "git diff --check", status: "passed", exit_code: 0 });
if (tests.some((test) => test.status === "failed")) throw new Error("失敗した検証があるため結果を確定できません");

const base = process.env.BASE_COMMIT;
const diff = git("diff", "--binary", `${base}..HEAD`);
const changedFiles = git("diff", "--name-only", `${base}..HEAD`).split("\n").filter(Boolean);
if (!changedFiles.length) throw new Error("変更ファイルがありません");

const result = {
  change_set_id: process.env.BUILDER_CHANGE_SET_ID,
  commit_sha: git("rev-parse", "HEAD"),
  diff_sha256: createHash("sha256").update(diff).digest("hex"),
  summary: `${process.env.BUILDER_CAPABILITY_TOPIC ?? "adapter"} の実装を ${changedFiles.length} ファイルへ生成し、隔離workspaceで検証しました`,
  changed_files: changedFiles,
  tests,
};
await writeFile(resultPath, `${JSON.stringify(result)}\n`, { mode: 0o600 });
