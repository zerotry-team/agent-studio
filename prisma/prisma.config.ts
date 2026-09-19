import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";

loadEnv();
loadEnv({ path: ".env.local", override: false });

// マイグレーションはテーブル所有者のロールで行う（DIRECT_URL）。
// アプリ用の DATABASE_URL（RLS が効くロール）では DDL を実行できない。
const url = process.env.DIRECT_URL;

export default defineConfig({
  schema: "schema.prisma",
  migrations: {
    path: "migrations",
  },
  datasource: url ? { url, shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL } : undefined,
});
