/** Agent（モデル）に返すツールのエラー文。モデルが次の行動を判断できるように書く */
export const MESSAGES = {
  toolNotAllowed: (tool: string) => `ツール ${tool} はこのセッションでは使えません。`,
  invalidArguments: "ツールの引数は JSON のオブジェクトで指定してください。",
  approvalPending: (approvalId: string) =>
    `この操作には承認が必要です。承認依頼を送りました（承認ID: ${approvalId}）。承認されたら、同じ内容でもう一度実行してください。`,
  approvalDenied: "承認者がこの操作を却下しました。この操作は実行しないでください。",
  approvalExpired: "承認の期限が切れました。必要であれば、もう一度実行して承認を依頼してください。",
  approvalConsumed: "この承認はすでに使われています。必要であれば、もう一度実行して承認を依頼してください。",
  approvalUnavailable: "承認の状態を確認できませんでした。しばらく待ってから、もう一度実行してください。",
  executionFailed: (detail: string) => `ツールの実行に失敗しました: ${detail}`,
  httpError: (status: number, snippet: string) =>
    `業務システムがエラーを返しました（HTTP ${status}）${snippet ? `: ${snippet}` : ""}`,
  timeout: (ms: number) => `業務システムが時間内（${ms} ミリ秒）に応答しませんでした。`,
  missingUrlArgument: (name: string) => `引数 ${name} を指定してください。`,
  credentialsUnavailable: "業務システムの認証情報を取得できませんでした。管理者に連絡してください。",
  truncated: "\n…（長すぎるため途中で切り詰めました）",
} as const;
