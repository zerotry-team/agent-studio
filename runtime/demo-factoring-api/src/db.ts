import { Pool, types } from "pg";

// DATE は Date に変換させない。時差で日付が 1 日ずれるのを避け、"2026-11-30" のまま返す
types.setTypeParser(types.builtins.DATE, (value) => value);
// bigint（金額）は数値で返す。扱う額では精度が落ちない
types.setTypeParser(types.builtins.INT8, (value) => Number(value));

/** ファクタリング審査のデモ DB（factoring_demo）。Agent Studio の DB とは別のデータベース。 */
export const DEFAULT_DATABASE_URL = "postgresql://postgres:postgres@localhost:5434/factoring_demo";

export interface Db {
  query<T>(text: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export function createDb(connectionString: string): Db {
  const pool = new Pool({ connectionString, max: 4 });
  return {
    async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
      const result = await pool.query(text, params);
      return result.rows as T[];
    },
    close: () => pool.end(),
  };
}
