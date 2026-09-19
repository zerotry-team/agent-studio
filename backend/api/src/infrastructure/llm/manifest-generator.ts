import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { AppError } from "../../domain/errors.js";
import type { Logger } from "../../logger.js";

export interface GeneratorToolInfo {
  name: string;
  display_name: string;
  description: string;
  execution_location: string;
  risk: string;
  input_fields: string[];
}

export interface GeneratorProfileInfo {
  key: string;
  name: string;
  type: string;
}

/** Claude に返させる形。Manifest そのものより単純にして、Manifest への変換はコードで行う */
const generatedAgentSchema = z.object({
  key: z.string().describe("半角英小文字・数字・ハイフンのキー（例: pricing-agent）"),
  name: z.string().describe("日本語の短い名前"),
  description: z.string().describe("このエージェントが何をするかの日本語の説明（1〜2文）"),
  instructions: z.string().describe("エージェントへの日本語の指示。手順・確認事項・報告の仕方を具体的に"),
  tools: z.array(z.string()).describe("使うツールの name（与えられた一覧にあるものだけ）"),
  approval_rules: z
    .array(
      z.object({
        tool: z.string(),
        field: z.string().nullable().describe("条件に使う引数名。常に承認が必要なら null"),
        op: z.enum([">", ">=", "<", "<=", "==", "!="]).nullable(),
        value: z.number().nullable(),
        abs: z.boolean().describe("値の絶対値で比べるか"),
        reason: z.string().describe("承認が必要な理由（日本語）"),
      }),
    )
    .describe("承認が必要な操作"),
  environment_profile: z.string().nullable().describe("既定の実行環境のキー。候補がなければ null"),
  notes: z.array(z.string()).describe("利用者への補足（足りないツール、確認してほしい点など）"),
});
export type GeneratedAgent = z.infer<typeof generatedAgentSchema>;

// 変わらない部分だけをシステムプロンプトにしてキャッシュする（ツール一覧などはユーザーメッセージに入れる）
const SYSTEM_PROMPT = `あなたは「Agent Studio」で業務用 AI エージェントの定義を作るアシスタントです。
利用者が日本語で説明した業務から、エージェントの定義を作ります。

エージェントは、OpenAI Agents API 上で動き、与えられたツールを使って業務を行います。
ツールには次の実行場所があります。
- studio_function: Agent Studio が実行する（通知や Webhook など）
- openai_service_mcp: OpenAI から接続する公開サービス
- runtime_mcp: 企業の AWS 内で実行する社内システムの操作（SAP、社内 API、ブラウザ操作など）

ツールのリスク区分: read（参照のみ）, write（更新）, external_send（外部への送信）, financial（金額に関わる変更）, destructive（削除など取り消せない操作）

作り方の決まり:
1. tools には、与えられたツール一覧にある name だけを使う。業務に必要なのに一覧にないツールがあれば、notes にそのことを書く（存在しないツールを作らない）。
2. financial / destructive のツールや、金額・数量など大きな影響がある操作には approval_rules で承認条件を付ける。利用者が金額の上限などを示していれば、その値を条件に使う。
3. instructions は具体的に書く: 作業の手順、実行前に確認すること、変更前後の値の報告、判断に迷ったら作業を止めて確認を求めること。ツールが「承認が必要です」と返したら、承認待ちであることを伝えて待つこと。
4. 実行のたびに変わる値（例:「400円下げる」の 400）は instructions に固定で書かず、実行時の依頼で受け取る前提で書く。
5. key は業務を表す英語のハイフン区切り（例: pricing-agent）。name と description は日本語。
6. environment_profile は、社内システム（runtime_mcp）を使うなら企業の AWS の実行環境、使わないなら OpenAI の実行環境を候補から選ぶ。適切な候補がなければ null。`;

export interface ManifestGenerator {
  generate(input: {
    description: string;
    tools: GeneratorToolInfo[];
    profiles: GeneratorProfileInfo[];
  }): Promise<GeneratedAgent>;
}

/** Claude で生成する（D-9）。モデルは MANIFEST_GENERATOR_MODEL（既定 claude-opus-5） */
export class ClaudeManifestGenerator implements ManifestGenerator {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly logger: Logger,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 2 });
  }

  async generate(input: {
    description: string;
    tools: GeneratorToolInfo[];
    profiles: GeneratorProfileInfo[];
  }): Promise<GeneratedAgent> {
    const context = {
      available_tools: input.tools,
      environment_profiles: input.profiles,
    };

    try {
      const response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        // 安全性の分類で断られた場合に、推奨の代替モデルでサーバー側が再実行する
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [
          {
            role: "user",
            content: `# 使えるツールと実行環境\n${JSON.stringify(context, null, 2)}\n\n# 業務の説明\n${input.description}`,
          },
        ],
        output_config: { format: betaZodOutputFormat(generatedAgentSchema) },
      });

      if (response.stop_reason === "refusal") {
        throw new AppError("generation_refused", 400, "この内容ではエージェントの定義を作れませんでした。説明を見直してください");
      }
      if (response.stop_reason === "max_tokens" || !response.parsed_output) {
        throw new AppError("generation_failed", 502, "エージェントの定義を作れませんでした。もう一度お試しください");
      }
      this.logger.info(
        { usage: response.usage, model: response.model },
        "Manifest を生成しました",
      );
      return response.parsed_output;
    } catch (e) {
      if (e instanceof AppError) throw e;
      if (e instanceof Anthropic.RateLimitError) {
        throw new AppError("generation_rate_limited", 429, "混み合っています。しばらくしてからお試しください");
      }
      if (e instanceof Anthropic.APIError) {
        this.logger.error({ status: e.status, message: e.message }, "Manifest の生成に失敗しました");
        throw new AppError("generation_failed", 502, "エージェントの定義を作れませんでした。もう一度お試しください");
      }
      throw e;
    }
  }
}

/**
 * 生成用の API キーが無い環境（ローカル開発など）向けのひな形。
 * 業務の説明から最低限の定義を作り、notes で生成 AI を使っていないことを伝える。
 */
export class TemplateManifestGenerator implements ManifestGenerator {
  async generate(input: { description: string; tools: GeneratorToolInfo[]; profiles: GeneratorProfileInfo[] }): Promise<GeneratedAgent> {
    const readTools = input.tools.filter((t) => t.risk === "read").map((t) => t.name);
    return {
      key: "new-agent",
      name: "新しいエージェント",
      description: input.description.slice(0, 200),
      instructions: `次の業務を行ってください。\n${input.description}\n\n作業の前に内容を確認し、変更した場合は変更前後の値を報告してください。判断に迷ったら作業を止めて確認を求めてください。`,
      tools: readTools,
      approval_rules: [],
      environment_profile: input.profiles[0]?.key ?? null,
      notes: ["生成 AI が設定されていないため、ひな形を作成しました。内容を確認して編集してください。"],
    };
  }
}
