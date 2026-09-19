import "server-only";
import { AuthConfigError } from "@/lib/auth/config";

/** API の内部 URL（例: http://api:3200）。リクエスト時に読む */
export function getApiBaseUrl(): string {
  const value = process.env.API_INTERNAL_URL?.trim();
  if (value) return value.replace(/\/+$/, "");
  if (process.env.NODE_ENV === "production") {
    throw new AuthConfigError("環境変数 API_INTERNAL_URL が設定されていません");
  }
  return "http://localhost:3200";
}
