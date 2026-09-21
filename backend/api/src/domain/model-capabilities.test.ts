import { describe, expect, it } from "vitest";
import { inferModelCapabilities } from "./model-capabilities.js";

describe("model standard capability catalog", () => {
  it("OCR・画像生成・最新情報を標準能力へ先に分類する", () => {
    const decisions = inferModelCapabilities("領収書画像をOCRし、最新ニュースを調べ、サムネイル画像を生成して");
    expect(decisions.map((decision) => decision.capability)).toEqual([
      "text_reasoning", "vision_ocr", "image_generation", "web_search",
    ]);
    expect(decisions.find((decision) => decision.capability === "vision_ocr")).toMatchObject({ implementation: "model_intrinsic", requiresInputFile: true });
    expect(decisions.find((decision) => decision.capability === "image_generation")).toMatchObject({ implementation: "studio_builtin" });
  });
});
