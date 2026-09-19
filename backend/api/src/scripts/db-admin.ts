import { existsSync, readFileSync } from "node:fs";
import pg from "pg";

export const APP_ROLE = "agent_studio_app";

/**
 * マイグレーション用（テーブル所有者）の接続先。
 * - ローカル: DIRECT_URL
 * - ECS の migrate タスク: DB_HOST など + DB_ADMIN_SECRET（RDS が管理するマスターユーザーの JSON）
 */
export function adminConnection(): { url: string; client: pg.ClientConfig } {
  if (process.env.DIRECT_URL) {
    return { url: process.env.DIRECT_URL, client: { connectionString: process.env.DIRECT_URL } };
  }
  const secret = process.env.DB_ADMIN_SECRET;
  const host = process.env.DB_HOST;
  if (!secret || !host) throw new Error("DIRECT_URL、または DB_HOST と DB_ADMIN_SECRET を設定してください");
  const { username, password } = JSON.parse(secret) as { username: string; password: string };
  const port = process.env.DB_PORT ?? "5432";
  const database = process.env.DB_NAME ?? "agent_studio";
  const caPath = process.env.DB_SSL_CA_PATH ?? "/etc/ssl/certs/rds-global-bundle.pem";
  return {
    url: `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${database}?sslmode=require`,
    client: {
      host,
      port: Number(port),
      database,
      user: username,
      password,
      ssl: existsSync(caPath) ? { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true } : { rejectUnauthorized: false },
    },
  };
}

/**
 * アプリ用ロール（RLS が効く・BYPASSRLS なし・テーブル所有者ではない）を用意する。
 * パスワードは DB_APP_PASSWORD（Secrets Manager から注入）。何度実行してもよい。
 */
export async function ensureAppRole(config: pg.ClientConfig, appPassword: string): Promise<void> {
  const client = new pg.Client(config);
  await client.connect();
  try {
    const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [APP_ROLE]);
    const password = client.escapeLiteral(appPassword);
    if (exists.rowCount === 0) {
      await client.query(`CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${password}`);
    } else {
      await client.query(`ALTER ROLE ${APP_ROLE} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${password}`);
    }
    const db = (await client.query<{ db: string }>("SELECT current_database() AS db")).rows[0]!.db;
    await client.query(`GRANT CONNECT ON DATABASE ${client.escapeIdentifier(db)} TO ${APP_ROLE}`);
  } finally {
    await client.end();
  }
}
