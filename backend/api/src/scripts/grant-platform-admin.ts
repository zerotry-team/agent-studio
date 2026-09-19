import { adminConnection, grantPlatformAdmin } from "./db-admin.js";

/**
 * 運営管理者を設定する。
 *   node dist/scripts/grant-platform-admin.js <email>
 * ECS では migrate のタスク定義を使い、command を上書きして run-task する（DB_ADMIN_SECRET が必要）。
 * 最初の1人は Terraform の initial_admin_email で設定されるので、2人目以降に使う。
 */
const email = process.argv[2];
if (!email) {
  console.error("使い方: grant-platform-admin <email>");
  process.exit(1);
}
await grantPlatformAdmin(adminConnection().client, email);
console.log(`${email} を運営管理者にしました`);
