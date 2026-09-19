import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { adminConnection, ensureAppRole, grantPlatformAdmin } from "./db-admin.js";

/**
 * ECS の migrate タスク（CI/CD が run-task する）。
 * 1. アプリ用ロールを用意する（パスワードは Secrets Manager の値に合わせる）
 * 2. prisma migrate deploy（テーブル所有者のロールで実行）
 */
const appPassword = process.env.DB_APP_PASSWORD;
if (!appPassword) throw new Error("DB_APP_PASSWORD がありません");

const admin = adminConnection();
await ensureAppRole(admin.client, appPassword);
console.log("アプリ用ロールを確認しました");

const require = createRequire(import.meta.url);
const prismaCli = require.resolve("prisma/build/index.js");
// src/scripts と dist/scripts のどちらからでもリポジトリ直下の prisma/ を指す
const prismaConfig = fileURLToPath(new URL("../../../../prisma/prisma.config.ts", import.meta.url));
const result = spawnSync(process.execPath, [prismaCli, "migrate", "deploy", "--config", prismaConfig], {
  stdio: "inherit",
  env: { ...process.env, DIRECT_URL: admin.url },
});
if (result.status !== 0) {
  console.error("マイグレーションに失敗しました");
  process.exit(result.status ?? 1);
}
console.log("マイグレーションが完了しました");

// 最初の運営管理者（Terraform の initial_admin_email）。何度実行しても同じ結果になる
const initialAdmin = process.env.INITIAL_PLATFORM_ADMIN_EMAIL?.trim();
if (initialAdmin) {
  await grantPlatformAdmin(admin.client, initialAdmin);
  console.log("最初の運営管理者を設定しました");
}
