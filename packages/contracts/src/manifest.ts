import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { slugSchema } from "./common.js";
import { policySchema } from "./policy.js";

export const MANIFEST_SCHEMA_VERSION = 1 as const;

/** "update_price" または "update_price@2"（バージョン固定） */
export const toolRefSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}(@[1-9][0-9]*)?$/, "ツールの指定は「名前」または「名前@バージョン」です");

export const reasoningEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

/**
 * Agent Manifest（AGT-01）: Agent 定義の正本。
 * - organization_id は含めない（保存時にサーバーが決める）
 * - 実行時の入力（例:「400円下げる」）は含めない（AGT-05）
 * - 実行環境は Runtime を直接指定せず、実行環境の設定（プロファイル）のキーで参照する（AGT-06）
 */
export const agentManifestSchema = z
  .object({
    schema_version: z.literal(MANIFEST_SCHEMA_VERSION).default(MANIFEST_SCHEMA_VERSION),
    agent: z
      .object({
        key: slugSchema,
        name: z.string().trim().min(1).max(100),
        description: z.string().max(2000).optional(),
      })
      .strict(),
    model: z
      .object({
        name: z.string().min(1).max(100).optional(),
        reasoning_effort: reasoningEffortSchema.optional(),
      })
      .strict()
      .default({}),
    instructions: z.string().trim().min(1).max(32000),
    tools: z.array(toolRefSchema).max(64).default([]),
    policies: z.array(policySchema).max(64).default([]),
    environment: z
      .object({
        /** 既定の実行環境（runtime_profiles.key）。デプロイ時に変更できる */
        profile: slugSchema.optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

export type AgentManifest = z.infer<typeof agentManifestSchema>;
export type AgentManifestInput = z.input<typeof agentManifestSchema>;

export function parseToolRef(ref: string): { name: string; version?: number } {
  const [name, version] = ref.split("@");
  return version ? { name: name!, version: Number(version) } : { name: name! };
}

export type ManifestParseResult =
  | { ok: true; manifest: AgentManifest }
  | { ok: false; errors: { path: string; message: string }[] };

/** YAML / JSON 文字列または object を検証して Manifest にする */
export function parseManifest(source: string | unknown): ManifestParseResult {
  let raw: unknown = source;
  if (typeof source === "string") {
    try {
      raw = parseYaml(source);
    } catch (e) {
      return { ok: false, errors: [{ path: "", message: `YAML として読み込めません: ${(e as Error).message}` }] };
    }
  }
  const result = agentManifestSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    };
  }

  const errors: { path: string; message: string }[] = [];
  const names = result.data.tools.map((t) => parseToolRef(t).name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) errors.push({ path: "tools", message: `ツール ${dup} が重複しています` });
  result.data.policies.forEach((p, i) => {
    if (p.tool !== "*" && !names.includes(p.tool)) {
      errors.push({ path: `policies.${i}.tool`, message: `ツール ${p.tool} は tools に含まれていません` });
    }
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: result.data };
}

export function stringifyManifest(manifest: AgentManifest): string {
  return stringifyYaml(manifest, { lineWidth: 0 });
}
