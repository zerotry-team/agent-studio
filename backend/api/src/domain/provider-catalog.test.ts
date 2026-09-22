import { describe, expect, it } from "vitest";
import {
  PROVIDER_CATALOG,
  catalogEntryFor,
  matchProviders,
  minimalScopes,
  providerMatchPattern,
  selectOperations,
  toConnectorOperation,
} from "./provider-catalog.js";

describe("provider catalog", () => {
  it("依頼文からSlackを見つけ、通知に必要な操作と最小scopeだけを選ぶ", () => {
    const entries = matchProviders("請求書を読み取ってSlackに通知したい");
    expect(entries.map((entry) => entry.key)).toEqual(["slack"]);
    const slack = entries[0]!;
    const selected = selectOperations(slack, ["Slackのチャンネルへ通知する"]);
    expect(selected.map((operation) => operation.name)).toEqual(["slack_post_message", "slack_list_channels"]);
    expect(minimalScopes(slack, selected.map((operation) => operation.name))).toEqual(["chat:write", "channels:read"]);
  });

  it("どの操作にも一致しない場合は読み取り操作だけを登録し、書き込みは含めない", () => {
    const notion = catalogEntryFor({ key: "notion" })!;
    const selected = selectOperations(notion, ["関係ない要件"]);
    expect(selected.every((operation) => operation.risk === "read")).toBe(true);
    expect(selected.some((operation) => operation.name === "notion_search")).toBe(true);
  });

  it("社内DBの依頼はカタログに一致しない", () => {
    expect(matchProviders("自社DBから顧客履歴を取得したい")).toEqual([]);
  });

  it("旧データはprovider_keyがなくてもkeyで引ける", () => {
    expect(catalogEntryFor({ key: "qiita", provider_key: null })?.auth.kind).toBe("oauth2");
    expect(catalogEntryFor({ key: "my-qiita", provider_key: "qiita" })?.key).toBe("qiita");
    expect(catalogEntryFor({ key: "internal-db" })).toBeNull();
  });

  it("外部SaaS判定はカタログ外の名前（kintone等）も含む", () => {
    const pattern = providerMatchPattern();
    expect(pattern.test("kintoneの案件を取得する")).toBe(true);
    expect(pattern.test("Slackへ通知")).toBe(true);
    expect(pattern.test("社内の基幹システム")).toBe(false);
  });

  it("createConnectorへ渡す操作にカタログ専用項目を残さない", () => {
    const operation = toConnectorOperation(PROVIDER_CATALOG[0]!.operations[0]!) as Record<string, unknown>;
    expect(operation.keywords).toBeUndefined();
    expect(operation.scopes).toBeUndefined();
    expect(operation.probe).toBeUndefined();
  });

  it("カタログにSecretや認証情報の値を含まない", () => {
    const text = JSON.stringify(PROVIDER_CATALOG.map(({ match: _match, ...entry }) => entry));
    expect(text).not.toMatch(/client_secret"\s*:\s*"[^"]+/);
    expect(text).not.toMatch(/xox[bp]-/);
  });
});
