import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileBrowserProfileStore } from "./browser-profile-store.js";

const dirs: string[] = [];
const profileId = "00000000-0000-4000-8000-000000000001";

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("FileBrowserProfileStore", () => {
  it("profile本文をControl Plane向け結果へ含めず、0600のRun外Storeへ保存・復元・削除する", async () => {
    const root = await mkdtemp(join(tmpdir(), "as-browser-profile-"));
    dirs.push(root);
    const store = new FileBrowserProfileStore(root);
    const body = Buffer.from(JSON.stringify({ cookies: [{ name: "session", value: "secret", domain: "example.com", path: "/" }], origins: [] }));

    const stored = await store.put(profileId, body);
    expect(stored).toMatchObject({ key: expect.stringMatching(new RegExp(`^profiles/${profileId}/`)), sizeBytes: body.length });
    expect(JSON.stringify(stored)).not.toContain("secret");
    expect((await stat(join(root, stored.key))).mode & 0o777).toBe(0o600);
    expect(await store.get(stored.key)).toEqual(body);

    await store.delete(stored.key);
    await expect(readFile(join(root, stored.key))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("path traversalと大きすぎるProfileを拒否する", async () => {
    const root = await mkdtemp(join(tmpdir(), "as-browser-profile-"));
    dirs.push(root);
    const store = new FileBrowserProfileStore(root);
    await expect(store.get("profiles/../../secret.json")).rejects.toThrow("object key");
    await expect(store.put(profileId, Buffer.alloc(4 * 1024 * 1024 + 1))).rejects.toThrow("サイズ");
  });
});
