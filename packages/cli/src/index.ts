import { CliError } from "./api.js";
import { approve, connect, doctor, login, oauthApp, orgs, runtime, services, use } from "./commands.js";
import { githubConnect } from "./github.js";
import { parseArgs } from "./input.js";

const HELP = `agent-studio — Agent Studio の設定を画面操作なしで行う CLI

  login [--dev <email>] [--token <IDトークン>] [--api <URL>]   ログイン（本番はブラウザが開きます）
  orgs / use <slug>                                            組織の一覧・選択
  services                                                     連携できるサービスと接続状態
  connect <key> [--secret-stdin | --secret-env VAR]            接続（OAuth はブラウザ、API キーは標準入力か環境変数）
  oauth-app set <key> --client-id <ID> --client-secret-stdin   OAuth アプリの登録（オーナー、初回のみ）
  runtime add --aws-account <ID> [--region] [--project <ID>]   貴社 AWS 用 Runtime の作成と登録用トークン
  runtime list | runtime token <id> | runtime secret <key>     Runtime の一覧・再発行・貴社 AWS に置く認証情報
  github connect --org <GitHubの組織名> [--repo owner/name]     GitHub App の作成〜接続（ブラウザで 2 回押すだけ）
  approve <作成プロジェクトID>                                  本番への昇格を承認
  doctor                                                       人の操作を待っている Agent 作成と、解決するコマンド

秘密の値は引数に渡さず、標準入力（--secret-stdin）か環境変数（--secret-env VAR）で渡します。
設定ファイル: ~/.config/agent-studio/config.json（トークンと組織だけ。API キーは保存しません）
`;

export async function main(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const [command, sub, ...rest] = positional;
  try {
    switch (command) {
      case "login": return await login(flags);
      case "orgs": return await orgs();
      case "use": return await use(sub);
      case "services": return await services();
      case "connect": return await connect(sub, flags);
      case "oauth-app": return await oauthApp(sub, rest[0], flags);
      case "runtime": return await runtime(sub, rest, flags);
      case "github":
        if (sub !== "connect") throw new CliError("使い方: agent-studio github connect --org <GitHubの組織名>");
        return await githubConnect(flags);
      case "approve": return await approve(sub);
      case "doctor": return await doctor();
      default:
        console.log(HELP);
        if (command && command !== "help" && command !== "--help") process.exitCode = 1;
    }
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`エラー: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

if (process.argv[1] && /src[\\/]index\.ts$/.test(process.argv[1])) {
  void main(process.argv.slice(2));
}
