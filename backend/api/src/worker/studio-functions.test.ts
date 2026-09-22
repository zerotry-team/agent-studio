import { describe, expect, it } from "vitest";
import {
  buildIdempotencyKey,
  buildImageGenerationRequest,
  buildZennArticle,
  prepareHttpArguments,
  validateAnonymousXPost,
  zennArticleSlug,
} from "./studio-functions.js";

describe("画像生成provider互換", () => {
  it("Orca Routerでは上流が拒否するresponse_formatとOpenAI固有optionを送らない", () => {
    expect(buildImageGenerationRequest("orcarouter", "openai/gpt-image-1", "test prompt")).toEqual({
      model: "openai/gpt-image-1",
      prompt: "test prompt",
      size: "1024x1024",
    });
  });

  it("チェックOFFのOpenAI requestは従来optionを維持する", () => {
    expect(buildImageGenerationRequest("openai", "gpt-image-1", "test prompt")).toEqual({
      model: "gpt-image-1",
      prompt: "test prompt",
      size: "1024x1024",
      quality: "medium",
      output_format: "png",
    });
  });
});

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

describe("X公開payload境界", () => {
  it("匿名ID・一般化結果・理由コードだけの固定本文を許可する", () => {
    expect(() => validateAnonymousXPost({
      account_id: "x-test-account",
      text: "匿名審査ID=ANON-ABCD1234; 結果=approve_candidate; 理由=NEW_UNDER_THRESHOLD,PAYMENTS_CONSISTENT; 検証用投稿",
      logical_post_id: "workflow-run-1",
    })).not.toThrow();
  });

  it.each([
    { account_id: "x", text: "株式会社実在 1000000円", logical_post_id: "r" },
    { account_id: "x", text: "匿名審査ID=ANON-ABCD1234; 結果=reject; 理由=COMPLIANCE_HIT; 検証用投稿", logical_post_id: "r" },
    { account_id: "x", text: "匿名審査ID=ANON-ABCD1234; 結果=hold; 理由=MANUAL_REVIEW_REQUIRED; 検証用投稿", customer_name: "禁止" },
  ])("禁止情報・否決・追加fieldを承認済みでも拒否する", (args) => {
    expect(() => validateAnonymousXPost(args)).toThrow();
  });
});

describe("Zenn GitHub Publisher", () => {
  it("Zenn frontmatterを安全なscalarで生成する", () => {
    const article = buildZennArticle({
      title: 'Agent Studio: "検証"',
      body: "# 本文\n\n検証しました。",
      emoji: "🤖",
      type: "tech",
      topics: ["AI", "Zenn", "AI"],
    });
    expect(article.markdown).toContain('title: "Agent Studio: \\"検証\\""');
    expect(article.markdown).toContain('topics: ["AI","Zenn"]');
    expect(article.markdown).toContain("published: true");
  });

  it("同じRunは同じslugになり、別Runでは変わる", () => {
    expect(zennArticleSlug("run-1")).toBe(zennArticleSlug("run-1"));
    expect(zennArticleSlug("run-1")).not.toBe(zennArticleSlug("run-2"));
    expect(zennArticleSlug("run-1")).toMatch(/^[a-f0-9]{16}$/);
  });
});
