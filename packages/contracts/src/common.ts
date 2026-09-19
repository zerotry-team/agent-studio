import { z } from "zod";

/** 組織内で一意なキー（URL・Manifest 内の参照に使う）。権限判定には使わない。 */
export const slugSchema = z
  .string()
  .min(2)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "半角英小文字・数字・ハイフンで入力してください");

/** ツール名。MCP のツール名としてそのまま使う。 */
export const toolNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, "半角英小文字・数字・アンダースコアで入力してください");

export const uuidSchema = z.uuid();

export const stageSchema = z.enum(["staging", "production"]);
export type Stage = z.infer<typeof stageSchema>;

export const memberRoleSchema = z.enum(["owner", "admin", "builder", "operator", "viewer"]);
export type MemberRole = z.infer<typeof memberRoleSchema>;

const ROLE_RANK: Record<MemberRole, number> = {
  viewer: 0,
  operator: 1,
  builder: 2,
  admin: 3,
  owner: 4,
};

/** role が required 以上の権限を持つか */
export function hasRoleAtLeast(role: MemberRole, required: MemberRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

/** JSON 値 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const jsonObjectSchema = z.record(z.string(), z.unknown());

/**
 * キー順を正規化した JSON 文字列。承認の「引数ハッシュ」に使うため、
 * 同じ内容なら必ず同じ文字列になるようにする。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** SHA-256（16進）。Node 20+ とブラウザの Web Crypto で動く。 */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** ツール呼び出しの引数ハッシュ（ツール名 + 正規化した引数） */
export async function toolCallHash(tool: string, args: unknown): Promise<string> {
  return sha256Hex(`${tool}\n${canonicalJson(args)}`);
}
