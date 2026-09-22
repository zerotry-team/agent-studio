// PR と main で実行する検査: 形式・import・秘密情報・テスト
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ADAPTERS_DIR, listAdapters, readAdapter, scanSecrets } from "./lib.mjs";

const adapters = listAdapters();
const errors = [];
for (const key of adapters) errors.push(...readAdapter(key).errors);
errors.push(...scanSecrets());
if (errors.length) {
  console.error("Adapter の検査で問題が見つかりました:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
for (const key of adapters) {
  const result = spawnSync(process.execPath, ["--test", join(ADAPTERS_DIR, key, "index.test.mjs")], { stdio: "inherit", timeout: 300_000 });
  if (result.status !== 0) {
    console.error(`- ${key}: テストが失敗しました`);
    process.exit(1);
  }
}
console.log(adapters.length ? `Adapter ${adapters.length} 件の検査が通りました: ${adapters.join(", ")}` : "Adapter はまだありません");
