import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSecretStore, MemorySecretStore } from "./secret-store.js";

describe("FileSecretStore", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "as-secrets-"));
    file = join(dir, "secrets.json");
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it("保存した値を参照（ARN）で読み戻せる", async () => {
    const store = new FileSecretStore(file);
    const arn = await store.put("agent-studio/local/orgs/o1/openai-app-key", "v-1");
    expect(await store.get(arn)).toBe("v-1");
  });

  it("別のプロセス（別インスタンス）からも同じ値が読める", async () => {
    const arn = await new FileSecretStore(file).put("a/b", "v-1");
    expect(await new FileSecretStore(file).get(arn)).toBe("v-1");
  });

  it("同じ名前に入れ直すと参照は変わらず、値だけ新しくなる", async () => {
    const store = new FileSecretStore(file);
    const first = await store.put("a/b", "v-1");
    const second = await store.put("a/b", "v-2");
    expect(second).toBe(first);
    expect(await store.get(first)).toBe("v-2");
  });

  it("別の名前の値は消えない", async () => {
    const store = new FileSecretStore(file);
    const one = await store.put("a/b", "v-1");
    const two = await store.put("c/d", "v-2");
    expect(await store.get(one)).toBe("v-1");
    expect(await store.get(two)).toBe("v-2");
  });

  it("ファイルが無いとき・未知の参照のときは null", async () => {
    const store = new FileSecretStore(file);
    expect(await store.get("arn:aws:secretsmanager:local:000000000000:secret:none")).toBeNull();
    await store.put("a/b", "v-1");
    expect(await store.get("arn:aws:secretsmanager:local:000000000000:secret:none")).toBeNull();
  });

  it("値はファイルに残り、本人だけが読める権限になる", async () => {
    await new FileSecretStore(file).put("a/b", "v-1");
    const { mode } = await import("node:fs/promises").then((m) => m.stat(file));
    expect(mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      "arn:aws:secretsmanager:local:000000000000:secret:a/b": "v-1",
    });
  });
});

describe("MemorySecretStore", () => {
  it("同じインスタンスでだけ読める（プロセスをまたがない）", async () => {
    const arn = await new MemorySecretStore().put("a/b", "v-1");
    expect(await new MemorySecretStore().get(arn)).toBeNull();
  });
});
