import { createHash, randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import { parseManifest, stringifyManifest, type ToolVersionSpecInput } from "@agent-studio/contracts";
import { adminConnection } from "./db-admin.js";

/**
 * ローカル開発用のデータ（yarn prisma:seed）。テーブル所有者で接続するため RLS は効かない。
 * - 運営管理者: admin@example.com
 * - Sample A 社: owner@sample-a.example（owner・承認者）、operator@sample-a.example
 * - Sample B 社: owner@sample-b.example（組織の分離を確認するため）
 * AUTH_MODE=dev では Authorization: Bearer dev:<email> でログインできる。
 */
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: adminConnection().url }) });

async function user(email: string, isPlatformAdmin = false) {
  return prisma.users.upsert({
    where: { email },
    create: { email, auth_subject: `dev|${email}`, display_name: email.split("@")[0], is_platform_admin: isPlatformAdmin },
    update: { is_platform_admin: isPlatformAdmin },
  });
}

async function org(slug: string, name: string) {
  return prisma.organizations.upsert({ where: { slug }, create: { slug, name }, update: {} });
}

async function member(organizationId: string, userId: string, role: string, isApprover: boolean) {
  await prisma.organization_members.upsert({
    where: { organization_id_user_id: { organization_id: organizationId, user_id: userId } },
    create: { organization_id: organizationId, user_id: userId, role, is_approver: isApprover },
    update: { role, is_approver: isApprover },
  });
}

async function tool(organizationId: string, name: string, displayName: string, spec: ToolVersionSpecInput) {
  const existing = await prisma.tools.findUnique({ where: { organization_id_name: { organization_id: organizationId, name } } });
  if (existing) return existing;
  return prisma.tools.create({
    data: {
      organization_id: organizationId,
      name,
      display_name: displayName,
      execution_location: spec.execution_location,
      risk: spec.risk,
      versions: { create: { version: 1, spec: spec as Prisma.InputJsonValue } },
    },
  });
}

async function main() {
  await user("admin@example.com", true);
  const ownerA = await user("owner@sample-a.example");
  const operatorA = await user("operator@sample-a.example");
  const ownerB = await user("owner@sample-b.example");

  const a = await org("sample-a-company", "Sample A 株式会社");
  const b = await org("sample-b-company", "Sample B 株式会社");
  await member(a.id, ownerA.id, "owner", true);
  await member(a.id, operatorA.id, "operator", false);
  await member(b.id, ownerB.id, "owner", true);
  for (const o of [a, b]) {
    await prisma.organization_openai_settings.upsert({ where: { organization_id: o.id }, create: { organization_id: o.id }, update: {} });
  }

  // 社内 API（Runtime の Tool Gateway 経由）
  await tool(a.id, "get_product", "商品情報の取得", {
    execution_location: "runtime_mcp",
    description: "商品 ID を指定して、商品名と現在の価格を取得する",
    risk: "read",
    input_schema: { type: "object", properties: { product_id: { type: "string" } }, required: ["product_id"], additionalProperties: false },
  });
  await tool(a.id, "update_price", "価格の変更", {
    execution_location: "runtime_mcp",
    description: "商品の価格を、指定した金額だけ変更する（値下げは負の数）",
    risk: "financial",
    input_schema: {
      type: "object",
      properties: { product_id: { type: "string" }, price_change: { type: "number" } },
      required: ["product_id", "price_change"],
      additionalProperties: false,
    },
  });

  // OpenAI の環境（ツールなしで試せる）
  const openaiProfile = await prisma.runtime_profiles.upsert({
    where: { organization_id_key: { organization_id: a.id, key: "openai-general" } },
    create: { organization_id: a.id, key: "openai-general", name: "OpenAI の環境（標準）", type: "openai_hosted", template: "general-python", network: { mode: "disabled" } },
    update: {},
  });

  // ローカル用の Runtime（RUNTIME_IDENTITY_MODE=dev の Controller が dev://111111111111/as-sample-a-dev-runtime で登録する）
  const runtime = await prisma.runtimes.upsert({
    where: { aws_account_id_expected_role_name: { aws_account_id: "111111111111", expected_role_name: "as-sample-a-dev-runtime" } },
    create: {
      organization_id: a.id,
      name: "Sample A（ローカル）",
      stage: "production",
      provisioning_type: "studio_managed",
      aws_account_id: "111111111111",
      aws_region: "ap-northeast-1",
      expected_role_name: "as-sample-a-dev-runtime",
    },
    update: {},
  });
  await prisma.runtime_profiles.upsert({
    where: { organization_id_key: { organization_id: a.id, key: "sample-a-production" } },
    create: { organization_id: a.id, key: "sample-a-production", name: "Sample A の AWS（本番）", type: "self_hosted", runtime_id: runtime.id },
    update: {},
  });

  let bootstrapToken: string | null = null;
  if (runtime.status === "pending") {
    bootstrapToken = `asbt_${randomBytes(32).toString("base64url")}`;
    await prisma.runtime_bootstrap_tokens.create({
      data: {
        organization_id: a.id,
        runtime_id: runtime.id,
        token_hash: createHash("sha256").update(bootstrapToken).digest("hex"),
        expires_at: new Date(Date.now() + 24 * 3600_000),
      },
    });
  }

  // すぐ試せるエージェント（ツールなし、OpenAI の環境）
  const helloYaml = `
agent:
  key: hello-agent
  name: あいさつエージェント
  description: 依頼の内容を要約して返す、動作確認用のエージェント
instructions: |
  依頼の内容を短く要約し、次に何をすべきかを1〜3点で提案してください。
`;
  const parsed = parseManifest(helloYaml);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const existingAgent = await prisma.agents.findUnique({ where: { organization_id_key: { organization_id: a.id, key: "hello-agent" } } });
  if (!existingAgent) {
    const agent = await prisma.agents.create({
      data: {
        organization_id: a.id,
        key: "hello-agent",
        name: parsed.manifest.agent.name,
        description: parsed.manifest.agent.description ?? null,
        latest_version: 1,
        created_by: ownerA.id,
        versions: {
          create: {
            version: 1,
            status: "published",
            published_at: new Date(),
            manifest: parsed.manifest as unknown as Prisma.InputJsonValue,
            manifest_yaml: stringifyManifest(parsed.manifest),
            created_by: ownerA.id,
          },
        },
      },
      include: { versions: true },
    });
    console.log(`エージェント hello-agent を作成しました（デプロイは画面または API で行ってください: runtime_profile_id=${openaiProfile.id}）`);
    void agent;
  }

  console.log("シードが完了しました");
  console.log(`  Sample A 社: ${a.id}`);
  console.log(`  Sample B 社: ${b.id}`);
  if (bootstrapToken) console.log(`  ローカル Runtime の登録用トークン（24時間有効）: ${bootstrapToken}`);
}

await main();
await prisma.$disconnect();
