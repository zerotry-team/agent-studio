import { z } from "zod";

/**
 * Zod のメッセージを、利用者に分かりやすい日本語にする。
 * - スキーマ側で指定したメッセージ（contracts の「半角英小文字・数字・ハイフンで…」など）が最優先
 * - よく出るエラーはここで言い換え、それ以外は Zod の日本語ロケールに任せる
 */
type LooseIssue = {
  code?: string;
  input?: unknown;
  expected?: string;
  origin?: string;
  format?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  inclusive?: boolean;
};

export function friendlyZodMessage(issue: LooseIssue): string | undefined {
  switch (issue.code) {
    case "invalid_type": {
      if (issue.input === undefined || issue.input === null || issue.input === "") return "入力してください";
      if (issue.expected === "number" || issue.expected === "int") return "数値で入力してください";
      if (issue.expected === "boolean") return "はい・いいえで指定してください";
      return "入力の形式が正しくありません";
    }
    case "too_small": {
      const min = Number(issue.minimum);
      if (issue.origin === "string") return min <= 1 ? "入力してください" : `${min}文字以上で入力してください`;
      if (issue.origin === "array" || issue.origin === "set") return `${Math.max(min, 1)}件以上指定してください`;
      if (issue.origin === "number" || issue.origin === "int" || issue.origin === "bigint") {
        return issue.inclusive === false ? `${min}より大きい値を入力してください` : `${min}以上の値を入力してください`;
      }
      return undefined;
    }
    case "too_big": {
      const max = Number(issue.maximum);
      if (issue.origin === "string") return `${max}文字以内で入力してください`;
      if (issue.origin === "array" || issue.origin === "set") return `${max}件以内にしてください`;
      if (issue.origin === "number" || issue.origin === "int" || issue.origin === "bigint") {
        return issue.inclusive === false ? `${max}より小さい値を入力してください` : `${max}以下の値を入力してください`;
      }
      return undefined;
    }
    case "invalid_format": {
      if (issue.format === "email") return "メールアドレスの形式が正しくありません";
      if (issue.format === "url") return "URL の形式が正しくありません";
      if (issue.format === "uuid" || issue.format === "guid") return "選択してください";
      if (issue.format === "datetime") return "日時の形式が正しくありません";
      return "入力の形式が正しくありません";
    }
    case "invalid_value":
      return "選択肢の中から選んでください";
    case "unrecognized_keys":
      return "不要な項目が含まれています";
    case "invalid_union":
      return "入力内容が正しくありません";
    default:
      return undefined;
  }
}

let configured = false;
export function ensureJapaneseZodMessages(): void {
  if (configured) return;
  configured = true;
  z.config(z.locales.ja());
  z.config({ customError: (issue) => friendlyZodMessage(issue as LooseIssue) });
}

ensureJapaneseZodMessages();

/** Zod のエラーを「項目のパス → 最初のメッセージ」に変換する */
export function zodFieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join(".");
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}
