/** 例として表示する業務の説明 */
export const DESCRIPTION_EXAMPLE =
  "指定された商品の価格を、指示された金額だけ変更する。変更の前後で価格を確認して報告する。500円を超える値下げは承認を必要にする。";

/** YAML のブロック（|）の中に入れるため、各行を字下げする */
function indentBlock(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split(/\r?\n/)
    .map((line) => (line.trim() === "" ? "" : `${pad}${line.trimEnd()}`))
    .join("\n");
}

/**
 * 「YAML を直接書く」ときのひな形。agentManifestSchema を満たす最小限の定義。
 * 業務の説明が入力済みなら、指示（instructions）に入れておく。
 */
export function buildStarterManifest(description?: string): string {
  const body = description?.trim()
    ? indentBlock(description.trim(), 2)
    : indentBlock("ここにエージェントへの指示を書いてください。\n例: 指定された商品の価格を、指示された金額だけ変更する。変更の前後で価格を確認して報告する。", 2);

  return `schema_version: 1
agent:
  # 組織の中で重ならないキー（半角英小文字・数字・ハイフン）。あとから変更できません
  key: my-agent
  name: 新しいエージェント
  description: このエージェントが行う仕事の説明
instructions: |
${body}
# 使うツール（例: - get_product や - update_price@2）
tools: []
# ルール（例: 500円を超える値下げは承認が必要）
#   - type: approval
#     tool: update_price
#     when: { field: price_change, op: ">", value: 500, abs: true }
policies: []
# 既定の実行環境（実行環境のキー）。デプロイするときにも選べます
environment: {}
`;
}
