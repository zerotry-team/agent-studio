import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

// README の手順どおり、リポジトリルートのローカル設定を使って実行できるようにする。
// CI では既に設定された環境変数を dotenv が上書きしないため、同じ設定を利用できる。
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

// DB（PostgreSQL）が必要なテスト。DATABASE_URL（アプリ用ロール）と DIRECT_URL（所有者）を使う
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
