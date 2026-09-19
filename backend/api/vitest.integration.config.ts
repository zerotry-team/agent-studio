import { defineConfig } from "vitest/config";

// DB（PostgreSQL）が必要なテスト。DATABASE_URL（アプリ用ロール）と DIRECT_URL（所有者）を設定して実行する
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
