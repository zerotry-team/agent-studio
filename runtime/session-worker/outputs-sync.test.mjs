// node --test runtime/session-worker/outputs-sync.test.mjs
import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listOutputFiles, syncOnce } from "./outputs-sync.mjs";

test("回収対象のディレクトリだけを送り、変わっていないファイルは送り直さない", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "outputs-sync-"));
  await mkdir(join(workspace, "outputs/sub"), { recursive: true });
  await mkdir(join(workspace, "generated_images"), { recursive: true });
  await mkdir(join(workspace, "repo"), { recursive: true });
  await writeFile(join(workspace, "outputs/report.csv"), "id,total\n1,100\n");
  await writeFile(join(workspace, "outputs/sub/memo.md"), "# memo");
  await writeFile(join(workspace, "outputs/.hidden"), "x");
  await writeFile(join(workspace, "generated_images/dog.png"), "png");
  await writeFile(join(workspace, "repo/secret.txt"), "secret");
  await symlink("/etc/hosts", join(workspace, "outputs/hosts"));

  const files = (await listOutputFiles(workspace)).map((file) => file.path);
  assert.deepEqual(files, ["outputs/report.csv", "outputs/sub/memo.md", "generated_images/dog.png"]);

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization, sha: init.headers["x-content-sha256"] });
    return new Response("{}", { status: 200 });
  };
  const sent = new Map();
  await syncOnce({ workspace, url: "http://gw/session-outputs/s1", token: "t", sent, fetchImpl });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "http://gw/session-outputs/s1/outputs/report.csv");
  assert.equal(calls[0].auth, "Bearer t");
  await syncOnce({ workspace, url: "http://gw/session-outputs/s1", token: "t", sent, fetchImpl });
  assert.equal(calls.length, 3);

  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(join(workspace, "outputs/report.csv"), "id,total\n1,200\n");
  await syncOnce({ workspace, url: "http://gw/session-outputs/s1", token: "t", sent, fetchImpl });
  assert.equal(calls.length, 4);
});

test("送れなかったファイルは次の周期で送り直す", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "outputs-sync-"));
  await mkdir(join(workspace, "outputs"), { recursive: true });
  await writeFile(join(workspace, "outputs/a.txt"), "a");
  let status = 503;
  let count = 0;
  const fetchImpl = async () => {
    count++;
    return new Response("{}", { status });
  };
  const sent = new Map();
  await syncOnce({ workspace, url: "http://gw/x", token: "t", sent, fetchImpl });
  status = 200;
  await syncOnce({ workspace, url: "http://gw/x", token: "t", sent, fetchImpl });
  await syncOnce({ workspace, url: "http://gw/x", token: "t", sent, fetchImpl });
  assert.equal(count, 2);
});
