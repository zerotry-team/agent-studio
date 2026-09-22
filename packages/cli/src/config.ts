import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * CLI の設定（~/.config/agent-studio/config.json）。
 * ここに置くのはログイン用トークンと選択中の組織だけ。連携サービスの API キーなどは一切保存しない。
 */
export interface CliConfig {
  api_url: string;
  token?: string;
  refresh_token?: string;
  token_expires_at?: string;
  organization_id?: string;
  organization_slug?: string;
}

export const DEFAULT_API_URL = "http://localhost:3200/api/v1";
/** ブラウザからの戻り先（OAuth / ログイン）。Provider や Cognito にもこの URI を登録する */
export const CALLBACK_PORT = 48127;

export function configDir(): string {
  return process.env.AGENT_STUDIO_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "agent-studio");
}

export function loadConfig(): CliConfig {
  try {
    const raw = readFileSync(join(configDir(), "config.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<CliConfig>;
    return { api_url: DEFAULT_API_URL, ...parsed };
  } catch {
    return { api_url: process.env.AGENT_STUDIO_API_URL ?? DEFAULT_API_URL };
  }
}

export function saveConfig(config: CliConfig): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir(), "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
