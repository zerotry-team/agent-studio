export const MODEL_STANDARD_CAPABILITIES = [
  "text_reasoning",
  "vision_ocr",
  "image_generation",
  "web_search",
  "computer_use",
] as const;

export type ModelStandardCapability = (typeof MODEL_STANDARD_CAPABILITIES)[number];

export interface ModelCapabilityDecision {
  capability: ModelStandardCapability;
  implementation: "model_intrinsic" | "openai_builtin" | "studio_builtin" | "browser_runtime";
  requiresInputFile: boolean;
  costClass: "included" | "token" | "image" | "browser";
  reason: string;
}

const OCR = /(?:ocr|文字起こし|読み取|読取|抽出).*(?:画像|写真|pdf|領収書|請求書|通帳)|(?:画像|写真|pdf|領収書|請求書|通帳).*(?:ocr|文字起こし|読み取|読取|抽出)/i;
const IMAGE_GENERATION = /(?:(?:画像|挿絵|イラスト|サムネイル).*(?:生成|作成|追加)|(?:生成|作成).*(?:画像|挿絵|イラスト|サムネイル))/i;
const FRESH_WEB = /(?:最新|今日|直近|現在|ニュース|トレンド|web|ウェブ|インターネット|公開情報|市場調査|競合.*(?:調査|比較)|おすすめ|評判|口コミ|価格比較|recent|latest|current|news)/i;
const COMPUTER = /(?:computer use|画面操作|ブラウザ操作|デスクトップ操作|web画面.*操作|ログイン.*操作)/i;

/** 外部Adapterを検討する前に、モデル標準能力で満たせる要求を決定論的に抽出する。 */
export function inferModelCapabilities(request: string): ModelCapabilityDecision[] {
  const decisions: ModelCapabilityDecision[] = [{
    capability: "text_reasoning",
    implementation: "model_intrinsic",
    requiresInputFile: false,
    costClass: "token",
    reason: "文章生成、要約、分類、推論はモデル自身で実行します",
  }];
  if (OCR.test(request)) decisions.push({
    capability: "vision_ocr",
    implementation: "model_intrinsic",
    requiresInputFile: true,
    costClass: "token",
    reason: "画像/PDFをモデルへ入力し、不要なCustom Backendを作りません",
  });
  if (IMAGE_GENERATION.test(request)) decisions.push({
    capability: "image_generation",
    implementation: "studio_builtin",
    requiresInputFile: false,
    costClass: "image",
    reason: "組織のOpenAI Projectを使う標準画像生成能力を利用します",
  });
  if (FRESH_WEB.test(request)) decisions.push({
    capability: "web_search",
    implementation: "openai_builtin",
    requiresInputFile: false,
    costClass: "token",
    reason: "時点依存情報のため、取得日時と出典を残せるWeb Searchを利用します",
  });
  if (COMPUTER.test(request)) decisions.push({
    capability: "computer_use",
    implementation: "browser_runtime",
    requiresInputFile: false,
    costClass: "browser",
    reason: "APIで解決できない許可済み画面操作だけを隔離Browser Runtimeで実行します",
  });
  return decisions;
}
