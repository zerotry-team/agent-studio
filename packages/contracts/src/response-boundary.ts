import { z } from "zod";

const fieldPathSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/).max(250);

export const responseBoundarySchema = z
  .object({
    allowed_fields: z.array(fieldPathSchema).min(1).max(200),
    max_bytes: z.number().int().min(1024).max(1024 * 1024).default(64 * 1024),
    max_records: z.number().int().min(1).max(100_000).default(100),
    allow_sensitive_fields: z.boolean().default(false),
  })
  .strict();
export type ResponseBoundary = z.infer<typeof responseBoundarySchema>;

const SENSITIVE_FIELD = /(?:^|_)(?:password|passwd|secret|token|api_key|bank_account|account_number|routing_number|credit_card|card_number|address|email|phone|ssn|tax_id)(?:$|_)/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getPath(value: Record<string, unknown>, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (!isObject(current) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]!;
    const next = current[part];
    current = isObject(next) ? next : ((current[part] = {}) as Record<string, unknown>);
  }
  current[parts.at(-1)!] = value;
}

function filterRecord(value: Record<string, unknown>, boundary: ResponseBoundary): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const path of boundary.allowed_fields) {
    const item = getPath(value, path);
    if (item !== undefined) setPath(output, path, item);
  }
  return output;
}

function recordCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (!isObject(value)) return 1;
  for (const key of ["data", "items", "results", "records"]) if (Array.isArray(value[key])) return value[key].length;
  return 1;
}

function findSensitivePath(value: unknown, prefix = ""): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSensitivePath(item, prefix);
      if (found) return found;
    }
    return null;
  }
  if (!isObject(value)) return null;
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (SENSITIVE_FIELD.test(key)) return path;
    const found = findSensitivePath(item, path);
    if (found) return found;
  }
  return null;
}

/** Raw responseを保存せず、その場で許可fieldだけに縮小する。 */
export function filterResponseFields(value: unknown, rawBoundary: ResponseBoundary): unknown {
  const boundary = responseBoundarySchema.parse(rawBoundary);
  if (recordCount(value) > boundary.max_records) throw new Error("API応答の件数がPolicy上限を超えています");
  const filtered = Array.isArray(value)
    ? value.map((item) => (isObject(item) ? filterRecord(item, boundary) : item))
    : isObject(value)
      ? filterRecord(value, boundary)
      : value;
  if (!boundary.allow_sensitive_fields) {
    const sensitive = findSensitivePath(filtered);
    if (sensitive) throw new Error(`API応答に機微情報fieldが含まれています: ${sensitive}`);
  }
  return filtered;
}

/** OpenAPIから取り込んだJSON Schemaの安全に検査できる部分だけをfail closedで検証する。 */
export function validateJsonSchema(value: unknown, schema: unknown, path = "$", depth = 0): void {
  if (!isObject(schema)) return;
  if (depth > 32) throw new Error("API応答schemaの階層が深すぎます");
  const type = schema.type;
  if (Array.isArray(type) && type.includes("null") && value === null) return;
  if (type === "object" || schema.properties) {
    if (!isObject(value)) throw new Error(`${path}はobjectではありません`);
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key}がありません`);
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validateJsonSchema(value[key], child, `${path}.${key}`, depth + 1);
    }
    return;
  }
  if (type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path}はarrayではありません`);
    for (let index = 0; index < value.length; index += 1) validateJsonSchema(value[index], schema.items, `${path}[${index}]`, depth + 1);
    return;
  }
  if (type === "string" && typeof value !== "string") throw new Error(`${path}はstringではありません`);
  if ((type === "number" || type === "integer") && typeof value !== "number") throw new Error(`${path}はnumberではありません`);
  if (type === "boolean" && typeof value !== "boolean") throw new Error(`${path}はbooleanではありません`);
  if (type === "null" && value !== null) throw new Error(`${path}はnullではありません`);
}
