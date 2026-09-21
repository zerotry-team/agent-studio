/** 依頼文から、企業専用Toolが扱う最小データ範囲を安全側に推定する。 */
export function inferCodeWorkspaceInterface(request: string, fallback: string): string {
  const normalized = request.replace(/\s+/g, " ").trim();
  const explicitRead = normalized.match(/(?:から|、|\s)([^。、\n]{1,50})で([^。、\n]{1,100})だけを(?:読み取|取得)/);
  if (explicitRead) {
    return `${explicitRead[1]!.trim()}で検索し、${explicitRead[2]!.trim()}だけを取得する。登録・更新はしない。`;
  }
  const inputOutput = normalized.match(/([^。、\n]{1,60})を(?:受け取り|入力(?:し|として)?)[^。、\n]{0,80}([^。、\n]{1,100})を(?:返す|取得する)/);
  if (inputOutput) {
    return `${inputOutput[1]!.trim()}を受け取り、${inputOutput[2]!.trim()}だけを返す。登録・更新はしない。`;
  }
  const writes = /(登録|更新|書き込|作成|削除|送信|投稿|変更)/.test(normalized);
  return writes
    ? `${fallback}。依頼に明示された項目だけを扱い、書き込み前に人の承認を必要とする。`
    : `${fallback}。依頼に必要な項目だけを取得し、登録・更新はしない。`;
}
