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
    const exists = await client.query<{ rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean; rolcreaterole: boolean }>(
      "SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1", [APP_ROLE],
    );
    const password = client.escapeLiteral(appPassword);
    if (exists.rowCount === 0) {
      await client.query(`CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${password}`);
    } else {
      // RDSの管理ユーザーは真のSUPERUSERではない。値がfalseでも属性の再指定は拒否される。
      // 既存ロールの安全性は検査し、パスワードなど変更可能な属性だけを更新する。
      if (exists.rows[0]!.rolsuper || exists.rows[0]!.rolbypassrls || exists.rows[0]!.rolcreatedb || exists.rows[0]!.rolcreaterole) {
        throw new Error(`${APP_ROLE} に管理者属性が設定されています。安全なアプリ用ロールが必要です`);
      }
      await client.query(`ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD ${password}`);
    }
    const db = (await client.query<{ db: string }>("SELECT current_database() AS db")).rows[0]!.db;
    await client.query(`GRANT CONNECT ON DATABASE ${client.escapeIdentifier(db)} TO ${APP_ROLE}`);
  } finally {
    await client.end();
  }
}

/** 運営管理者の権限を付ける（利用者がまだログインしていなければ、メールアドレスで先に作る） */
export async function grantPlatformAdmin(config: pg.ClientConfig, rawEmail: string): Promise<void> {
  const email = rawEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error("メールアドレスの形式が正しくありません");
  const client = new pg.Client(config);
  await client.connect();
  try {
    const res = await client.query<{ id: string }>(
      `INSERT INTO users (email, is_platform_admin) VALUES ($1, true)
       ON CONFLICT (email) DO UPDATE SET is_platform_admin = true, updated_at = now()
       RETURNING id`,
      [email],
    );
    await client.query(
      `INSERT INTO audit_logs (organization_id, actor_type, actor_label, action, target_type, target_id, result)
       VALUES (NULL, 'system', 'grant-platform-admin', 'user.platform_admin.grant', 'user', $1, 'success')`,
      [res.rows[0]!.id],
    );
  } finally {
    await client.end();
  }
}
