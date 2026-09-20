import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { DEFAULT_DATABASE_URL } from "./db.js";

/**
 * デモデータの投入。ローカルでも本番（一回限りの ECS タスク）でも同じコマンドで流す。
 * schema.sql は既存テーブルを落として作り直すため、--seed-only で seed.sql だけ流せるようにしている。
 */

const here = dirname(fileURLToPath(import.meta.url));
// dist/load.js から見ても src/load.ts から見ても db/ に届く
const dbDir = join(here, "..", "db");

function log(level: "info" | "error", message: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, time: new Date().toISOString(), service: "demo-factoring-api", msg: message, ...fields }));
}

async function main(): Promise<void> {
  const seedOnly = process.argv.includes("--seed-only");
  const connectionString = process.env.FACTORING_DATABASE_URL?.trim() || DEFAULT_DATABASE_URL;
  const files = seedOnly ? ["seed.sql"] : ["schema.sql", "seed.sql"];

  const pool = new Pool({ connectionString, max: 1 });
  try {
    for (const file of files) {
      const sql = await readFile(join(dbDir, file), "utf8");
      await pool.query(sql);
      log("info", "SQL を流しました", { file });
    }
    const counts = await pool.query<{ applicants: string; invoices: string; payments: string }>(
      `SELECT (SELECT count(*) FROM applicants) AS applicants,
              (SELECT count(*) FROM invoices) AS invoices,
              (SELECT count(*) FROM payment_records) AS payments`,
    );
    log("info", "デモデータを投入しました", counts.rows[0] ?? {});
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  log("error", "デモデータを投入できませんでした", { err: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
