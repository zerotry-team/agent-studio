import { existsSync, readFileSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import pg from "pg";
import type { Env } from "../../env.js";

export interface Database {
  prisma: PrismaClient;
  pool: pg.Pool;
  close(): Promise<void>;
}

/**
 * アプリ用ロール（agent_studio_app。RLS が効く）で接続する。
 * ECS では DB_HOST などから組み立て、RDS の CA で TLS を検証する。
 */
export function createDatabase(env: Env): Database {
  const poolConfig: pg.PoolConfig = env.DATABASE_URL
    ? { connectionString: env.DATABASE_URL }
    : {
        host: env.DB_HOST,
        port: env.DB_PORT,
        database: env.DB_NAME,
        user: env.DB_APP_USER,
        password: env.DB_APP_PASSWORD,
        ssl: existsSync(env.DB_SSL_CA_PATH)
          ? { ca: readFileSync(env.DB_SSL_CA_PATH, "utf8"), rejectUnauthorized: true }
          : { rejectUnauthorized: false },
      };

  if (!poolConfig.connectionString && !poolConfig.host) {
    throw new Error("DATABASE_URL または DB_HOST を設定してください");
  }

  const pool = new pg.Pool({
    ...poolConfig,
    max: env.DB_POOL_MAX,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 30000,
  });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  return {
    prisma,
    pool,
    async close() {
      await prisma.$disconnect();
      await pool.end().catch(() => undefined);
    },
  };
}
