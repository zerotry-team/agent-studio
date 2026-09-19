import type { SessionGrant } from "@agent-studio/contracts";
import { describe, expect, it } from "vitest";
import { GrantStore } from "./grants.js";

const hash = (c: string) => c.repeat(64);
const grant = (n: number, overrides: Partial<SessionGrant> = {}): SessionGrant => ({
  session_id: `00000000-0000-4000-8000-00000000000${n}`,
  run_id: `10000000-0000-4000-8000-00000000000${n}`,
  token_hash: hash(String(n)),
  allowed_tools: ["get_product"],
  policies: [],
  expires_at: "2026-09-19T12:00:00.000Z",
  ...overrides,
});
const before = new Date("2026-09-19T11:00:00Z");
const after = new Date("2026-09-19T12:00:01Z");

describe("GrantStore", () => {
  it("token_hash で許可情報を引ける（大文字でも可）", () => {
    const store = new GrantStore();
    store.upsert(grant(1));
    expect(store.lookupByTokenHash(hash("1"), before)?.session_id).toBe(grant(1).session_id);
    expect(store.lookupByTokenHash(hash("a"), before)).toBeUndefined();
    store.upsert(grant(2, { token_hash: hash("b") }));
    expect(store.lookupByTokenHash(hash("B"), before)?.session_id).toBe(grant(2).session_id);
  });

  it("期限切れの許可情報は返さない", () => {
    const store = new GrantStore();
    store.upsert(grant(1));
    expect(store.lookupByTokenHash(hash("1"), after)).toBeUndefined();
  });

  it("失効中（suspended）は何も返さない", () => {
    const store = new GrantStore();
    store.upsert(grant(1));
    store.suspended = true;
    expect(store.lookupByTokenHash(hash("1"), before)).toBeUndefined();
  });

  it("token_hash が変わったら古いハッシュでは引けない", () => {
    const store = new GrantStore();
    store.upsert(grant(1));
    store.upsert(grant(1, { token_hash: hash("c") }));
    expect(store.lookupByTokenHash(hash("1"), before)).toBeUndefined();
    expect(store.lookupByTokenHash(hash("c"), before)?.session_id).toBe(grant(1).session_id);
  });

  it("remove で引けなくなる", () => {
    const store = new GrantStore();
    store.upsert(grant(1));
    store.remove(grant(1).session_id);
    expect(store.lookupByTokenHash(hash("1"), before)).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it("syncFromActive: Worker の無いセッションは一覧に無ければ消し、Worker のあるものは残す", () => {
    const store = new GrantStore();
    store.upsert(grant(1), { worker: { status: "running", taskArn: "arn:1", startedAt: before } });
    store.upsert(grant(2));
    store.syncFromActive([grant(3)], 120);
    expect(store.has(grant(1).session_id)).toBe(true);
    expect(store.has(grant(2).session_id)).toBe(false);
    expect(store.has(grant(3).session_id)).toBe(true);
    expect(store.activeSessionIds()).toEqual([grant(1).session_id]);
  });

  it("upsert は Worker の状態を保ったまま許可情報を更新する", () => {
    const store = new GrantStore();
    store.upsert(grant(1), { worker: { status: "running", taskArn: "arn:1", startedAt: before } });
    store.upsert(grant(1, { allowed_tools: ["get_product", "update_price"] }));
    const record = store.get(grant(1).session_id)!;
    expect(record.worker?.taskArn).toBe("arn:1");
    expect(record.grant.allowed_tools).toEqual(["get_product", "update_price"]);
  });

  it("sweepExpired は Worker の無い期限切れだけを消す", () => {
    const store = new GrantStore();
    store.upsert(grant(1), { worker: { status: "running", taskArn: "arn:1", startedAt: before } });
    store.upsert(grant(2));
    expect(store.sweepExpired(after)).toBe(1);
    expect(store.has(grant(1).session_id)).toBe(true);
    expect(store.has(grant(2).session_id)).toBe(false);
  });
});
