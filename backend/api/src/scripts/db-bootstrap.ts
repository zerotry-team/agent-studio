import { adminConnection, ensureAppRole } from "./db-admin.js";

/** ローカル開発: アプリ用ロールを作る（yarn db:bootstrap） */
const password = process.env.APP_DB_PASSWORD ?? process.env.DB_APP_PASSWORD;
if (!password) throw new Error("APP_DB_PASSWORD を設定してください");
await ensureAppRole(adminConnection().client, password);
console.log("アプリ用ロール agent_studio_app を用意しました");
