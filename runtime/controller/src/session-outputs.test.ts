import { describe, expect, it } from "vitest";
import { sessionOutputsToken, sessionOutputsUrl } from "./session-outputs.js";

describe("作業領域の成果物の送信設定", () => {
  it("Tool Gatewayと同じtokenを作り、Gatewayの公開URLへ送る", () => {
    // runtime/tool-gateway/src/session-outputs-handler.test.ts と同じ計算であることを固定する
    expect(sessionOutputsToken("00000000-0000-4000-8000-000000000001", "a".repeat(64))).toBe(
      "fSrTmQ4MHvoj75IS3F1mw_OMwmr_pMgblsenx16N1fg",
    );
    expect(sessionOutputsUrl("http://gateway.internal:8080/mcp", "00000000-0000-4000-8000-000000000001"))
      .toBe("http://gateway.internal:8080/session-outputs/00000000-0000-4000-8000-000000000001");
  });
});
