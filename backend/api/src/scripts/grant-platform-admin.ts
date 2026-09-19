import pg from "pg";
import { adminConnection } from "./db-admin.js";

/**
 * 運営管理者を設定する（最初の1人を作るときに使う）。
 *   node dist/scripts/grant-platform-admin.js <email>
 * ECS では migrate のタスク定義を使い、command を上書きして run-task する（DB_ADMIN_SECRET が必要）。
 * 利用者がまだログインしていなくても、メールアドレスで先に作っておき、初回ログイン時に Cognito と紐づく。
 */
const email = process.argv[2]?.trim().toLowerCase();
if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) {
  console.error("使い方: grant-platform-admin <email>");
  process.exit(1);
}

const client = new pg.Client(adminConnection().client);
await client.connect();
try {
  const res = await client.query(
    `INSERT INTO users (email, is_platform_admin) VALUES ($1, true)
     ON CONFLICT (email) DO UPDATE SET is_platform_admin = true, updated_at = now()
     RETURNING id`,
    [email],
  );
  await client.query(
    `INSERT INTO audit_logs (organization_id, actor_type, actor_label, action, target_type, target_id, result)
     VALUES (NULL, 'system', 'grant-platform-admin', 'user.platform_admin.grant', 'user', $1, 'success')`,
    [res.rows[0].id],
  );
  console.log(`${email} を運営管理者にしました`);
} finally {
  await client.end();
}
