import { describe, expect, it } from "vitest";
import type { HumanActionDto } from "@agent-studio/contracts";
import { presentBuilderAction } from "./action-presentation";

describe("presentBuilderAction", () => {
  it("GitHub未連携はRepository入力ではなく初回連携だけを案内する", () => {
    const action = {
      type: "provider_app_registration",
      title: "企業専用Integration Repositoryを接続してください",
      reason: "企業専用Toolを実装するため",
      fields: [],
      instructions: [],
      resume_condition: { type: "github_repository_connected" },
    } as unknown as HumanActionDto;
    expect(presentBuilderAction(action)).toMatchObject({
      title: "GitHubと連携してください（初回のみ）",
      reason: expect.stringContaining("Repository名などの入力は不要"),
      primaryActionLabel: "GitHubと連携する",
    });
  });

  it("Agent Studio本体へのGitHub接続済みなら再連携させず専用Repositoryの自動作成へ進める", () => {
    const action = {
      type: "provider_app_registration",
      title: "GitHubと連携してください（初回のみ）",
      reason: "企業専用Toolを実装するため",
      fields: [],
      instructions: [],
      resume_condition: { type: "github_repository_connected", repository_connection_id: "github-core-connection" },
    } as unknown as HumanActionDto;
    expect(presentBuilderAction(action)).toMatchObject({
      title: "企業専用Integration Repositoryを自動準備します",
      requiresRepositoryChange: true,
      primaryActionLabel: "専用Repositoryを自動作成する",
    });
  });

  it("保存済みCode Workspace質問の技術用語を業務用語へ読み替える", () => {
    const action = {
      title: "社内システム用Toolの入出力を確認してください",
      reason: "企業専用Runtimeから実行するためです",
      fields: [{ name: "interface_notes", label: "Toolの入出力", secret: false, required: true }],
      instructions: [
        "基点branchはGitHubのdefault branchを自動検出します",
        "Builderは専用branchを使用し、mainへ直接pushしません",
        "契約テスト・静的検査・Secret検査が通った変更だけをPR候補にします",
      ],
      resume_condition: { type: "builder_answers", topic: "code_workspace:organization_contracts" },
    } as unknown as HumanActionDto;

    expect(presentBuilderAction(action, "社内DBから契約IDで契約状況と更新日だけを読み取る")).toMatchObject({
      title: "契約情報取得Toolを作成します",
      fields: [],
      primaryActionLabel: "契約情報取得Toolを作成する",
      implementation: {
        name: "契約情報取得Tool",
        outcome: "契約IDで検索し、契約状況と更新日だけを取得する。登録・更新はしない。",
        destination: "接続済みGitHub Repositoryの専用branch",
        changes: ["企業専用Runtimeから実行する連携コード", "Agentから呼び出すTool定義", "動作確認用の自動テスト"],
      },
    });
  });

  it("SNS分析用Toolは作るものと変更先がボタン単体でも分かる", () => {
    const action = {
      title: "社内システム用Toolの入出力を確認してください",
      reason: "企業専用Runtimeから実行するためです",
      fields: [],
      instructions: [
        "接続済みの sample-a/company-agent-tools を実装先として自動選択しました",
        "Builderは専用branchを使用し、mainへ直接pushしません",
      ],
      resume_condition: { type: "builder_answers", topic: "code_workspace:public_x_post", interface_notes: "指定したアカウントの公開投稿と反応情報だけを取得する。投稿はしない。" },
    } as unknown as HumanActionDto;
    expect(presentBuilderAction(action, "ベンチマーク投稿を分析する")).toMatchObject({
      title: "SNS投稿分析用データ取得Toolを作成します",
      primaryActionLabel: "SNS投稿分析用データ取得Toolを作成する",
      implementation: {
        destination: "sample-a/company-agent-tools の専用branch",
        outcome: "指定したアカウントの公開投稿と反応情報だけを取得する。投稿はしない。",
      },
    });
  });

  it("PR反映時は承認後にどこまで自動で進むかを明示する", () => {
    const action = {
      type: "repository_merge",
      title: "PR #17をreviewしてmergeしてください",
      reason: "Required Checksを確認するため",
      fields: [],
      instructions: ["https://github.example/pull/17"],
      resume_condition: { type: "git_pr_merged", pr_number: 17 },
    } as unknown as HumanActionDto;
    expect(presentBuilderAction(action)).toMatchObject({
      title: "テスト済みの変更をIntegration Repositoryへ反映します",
      primaryActionLabel: "承認してToolを反映する",
      reason: expect.stringContaining("RuntimeへのTool登録まで自動で追跡"),
    });
  });

  it("既存のAgent Studio本体選択は実装開始を止めて専用Repository接続へ案内する", () => {
    const action = {
      type: "business_rule_confirmation",
      title: "社内システム用Toolの実装先を確認してください",
      reason: "企業専用Runtimeで実行するため",
      fields: [],
      instructions: ["接続済みの zerotry-team/agent-studio を実装先として自動選択しました"],
      resume_condition: { type: "builder_answers", topic: "code_workspace:organization_tool", repository_url: "https://github.com/zerotry-team/agent-studio.git" },
    } as unknown as HumanActionDto;
    expect(presentBuilderAction(action)).toMatchObject({
      title: "企業専用Integration Repositoryを自動準備します",
      requiresRepositoryChange: true,
      implementation: null,
    });
  });
});
