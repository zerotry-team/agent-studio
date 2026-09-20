import { describe, expect, it } from "vitest";
import { buildIdempotencyKey, prepareHttpArguments } from "./studio-functions.js";

describe("HTTP Connectorの冪等性", () => {
  it("logical_post_idをIdempotency-Key用に分離し、接続先bodyへ送らない", () => {
    const prepared = prepareHttpArguments("POST", {
      account_id: "acc_1",
      text: "投稿本文",
      logical_post_id: "post-1",
    });

    expect(prepared).toEqual({
      requestArgs: { account_id: "acc_1", text: "投稿本文" },
      logicalId: "post-1",
    });
    expect(buildIdempotencyKey("run-1", "publish_post", prepared.logicalId)).toMatch(/^[a-f0-9]{64}$/);
    expect(buildIdempotencyKey("run-1", "publish_post", prepared.logicalId)).toBe(
      buildIdempotencyKey("run-1", "publish_post", prepared.logicalId),
    );
  });

  it("明示した内部フィールドだけを除去し、通常のPOST入力は保持する", () => {
    expect(prepareHttpArguments("POST", { payload: "value", request_ref: "ref-1" }, "request_ref")).toEqual({
      requestArgs: { payload: "value" },
      logicalId: "ref-1",
    });
    expect(prepareHttpArguments("GET", { logical_post_id: "provider-field" })).toEqual({
      requestArgs: { logical_post_id: "provider-field" },
      logicalId: "request",
    });
  });
});
