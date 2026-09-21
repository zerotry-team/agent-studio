import { describe, expect, it } from "vitest";
import type { CapabilityRequirementDto } from "@agent-studio/contracts";
import { annotateCapabilityFulfillment, classifyCapabilityFulfillment } from "./capability-fulfillment.js";

const missing = (requirement: string): CapabilityRequirementDto => ({
  requirement,
  state: "missing",
  connector_id: null,
  connector_name: null,
  tool_names: [],
  confidence: 1,
  reason: "一致するToolがありません",
  variables: [],
});

describe("classifyCapabilityFulfillment", () => {
  it("既存Toolの認証不足は新規開発せずConnection設定へ送る", () => {
    const requirement = { ...missing("Xへ投稿する"), state: "needs_connection" as const, tool_names: ["publish_post"], connector_name: "Social Router" };
    expect(classifyCapabilityFulfillment("Xへ投稿する", requirement).mode).toBe("configure");
  });

  it("kintoneは自社利用でもAgent Studio共通Toolへ送る", () => {
    const result = classifyCapabilityFulfillment("自社のkintoneから案件を取得したい", missing("kintoneの案件を取得する"));
    expect(result).toMatchObject({ mode: "shared_provider_adapter", owner: "agent_studio", availability_target_minutes: 15 });
  });

  it("社内DBは企業専用Runtime Toolへ送る", () => {
    const result = classifyCapabilityFulfillment("自社のDBから顧客履歴を取得したい", missing("顧客履歴を取得する"));
    expect(result).toMatchObject({ mode: "organization_private_adapter", owner: "organization", execution_location: "runtime" });
  });

  it("登録済み企業専用Toolの再利用先をStudioではなくRuntimeに保つ", () => {
    const requirement: CapabilityRequirementDto = {
      ...missing("社内契約DBを照会する"),
      state: "resolved",
      connector_name: "company contract lookup",
      tool_names: ["lookup_contract"],
      fulfillment: {
        mode: "reuse",
        owner: "organization",
        execution_location: "runtime",
        reason: "署名済みAdapter packageを企業専用Runtimeから再利用します",
        availability_target_minutes: null,
      },
    };
    expect(classifyCapabilityFulfillment("社内契約DBを照会する", requirement)).toMatchObject({
      mode: "reuse",
      owner: "organization",
      execution_location: "runtime",
    });
  });

  it("GitHubが実装先として書かれていても社内DB能力は共有Toolにしない", () => {
    const result = classifyCapabilityFulfillment(
      "会社のGitHubリポジトリへ専用バックエンドを作り、社内サーバーへ接続する",
      missing("企業専用Runtimeから社内システムの必要情報を取得する"),
    );
    expect(result).toMatchObject({ mode: "organization_private_adapter", owner: "organization", execution_location: "runtime" });
  });

  it("モデルだけで完結する能力はバックエンドを作らない", () => {
    const requirement = { ...missing("文章を要約する"), state: "resolved" as const };
    expect(classifyCapabilityFulfillment("文章を要約する", requirement).mode).toBe("model");
  });

  it("不足扱いのOCRや曖昧な抽出もモデルで解決済みにする", () => {
    const resolution = annotateCapabilityFulfillment("領収書画像から日付と金額を読み取りJSONで返す", {
      requirements: [missing("領収書をOCRして必要項目を抽出する")],
      selected_tools: [],
      missing_variables: [],
      ready: false,
    });
    expect(resolution).toMatchObject({ ready: true });
    expect(resolution.requirements[0]).toMatchObject({
      state: "resolved",
      tool_names: [],
      fulfillment: { mode: "model", owner: "model" },
    });
  });

  it("公開Web検索はOpenAI標準機能としてモデル経路にする", () => {
    const requirement = {
      ...missing("競合サービスの最新情報を調べる"),
      state: "resolved" as const,
      tool_names: ["web_search"],
      connector_name: "OpenAI標準機能",
    };
    expect(classifyCapabilityFulfillment("公開情報をWebで調べる", requirement).mode).toBe("model");
  });

  it("外部サービスへの送信はモデルだけで完了扱いにしない", () => {
    const result = classifyCapabilityFulfillment("メールで見積書を送信する", missing("外部へメールを送信する"));
    expect(result).toMatchObject({ mode: "shared_provider_adapter", owner: "agent_studio" });
  });
});
