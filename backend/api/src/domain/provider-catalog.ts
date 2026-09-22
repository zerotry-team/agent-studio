import type { ConnectorOperationInput, ProviderCatalogEntryDto } from "@agent-studio/contracts";

/**
 * よく使う外部サービスの連携定義。
 * 利用者に識別子・URL・操作一覧を入力させず、Builder Agentが依頼文から必要な操作だけを登録するための唯一の真実。
 * ここにはSecretを一切置かない（OAuthのClient Secret、APIキーはSecret Storeだけ）。
 */

export type CatalogOperation = ConnectorOperationInput & {
  /** 要件文とのマッチ語（日本語・英語）。selectOperations が使う */
  keywords: string[];
  /** この操作に必要な最小 OAuth scope */
  scopes?: string[];
  /** 接続テストや読み取りSmokeに使う代表操作。認証だけで結果が返る read 操作にする */
  probe?: boolean;
};

export type CatalogOAuth2 = {
  kind: "oauth2";
  authorize_url: string;
  token_url: string;
  scope_separator: " " | ",";
  pkce: boolean;
  /** token endpoint への送り方。Qiita は JSON 本文で受ける */
  token_request: "form" | "json";
  /** client 認証。body = client_id/client_secret を本文へ、basic = Authorization: Basic */
  token_auth: "body" | "basic";
  /** token レスポンスのどの項目が access token か */
  access_token_path: string;
  /** 接続名に使う利用者識別。Secret を返さない read 専用 endpoint */
  identity?: { url: string; id_path: string; label_path?: string };
  /** Provider 側で OAuth App を登録する管理画面 */
  console_url: string;
  header_name: "Authorization";
  extra_authorize_params?: Record<string, string>;
};

export type CatalogAuth =
  | { kind: "none" }
  | { kind: "static_bearer"; header_name: string; secret_label: string; secret_help: string; help_url?: string }
  | CatalogOAuth2
  /** GitHub は既存の GitHub App 経路（設定 > 詳細設定）へ委譲し、Connector は作らない */
  | { kind: "github_app" };

export type ProviderCatalogEntry = {
  /** connectors.key / connectors.provider_key と一致させる */
  key: string;
  name: string;
  description: string;
  /** 依頼文・要件文とのマッチ（日本語・英語） */
  match: RegExp;
  adapter: "http_openapi" | "mcp" | "runtime";
  base_url?: string;
  default_headers?: Record<string, string>;
  auth: CatalogAuth;
  operations: CatalogOperation[];
  /** 実行に Self-hosted Runtime が必要（ブラウザ操作など） */
  requires_self_hosted?: boolean;
  /** 定義を変えたら上げる。change set の source_hash に使う */
  version: number;
};

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object" as const,
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    key: "slack",
    name: "Slack",
    description: "Slackのチャンネルへ通知を投稿し、必要ならチャンネル一覧や履歴を読み取ります。",
    match: /slack|スラック/i,
    adapter: "http_openapi",
    base_url: "https://slack.com/api",
    auth: {
      kind: "oauth2",
      authorize_url: "https://slack.com/oauth/v2/authorize",
      token_url: "https://slack.com/api/oauth.v2.access",
      scope_separator: ",",
      pkce: false,
      token_request: "form",
      token_auth: "body",
      access_token_path: "access_token",
      identity: { url: "https://slack.com/api/auth.test", id_path: "team_id", label_path: "team" },
      console_url: "https://api.slack.com/apps",
      header_name: "Authorization",
    },
    operations: [
      {
        name: "slack_post_message",
        display_name: "Slackへ通知を投稿",
        description: "指定したチャンネルへメッセージを投稿する",
        method: "POST",
        path: "/chat.postMessage",
        risk: "external_send",
        input_schema: obj({ channel: { type: "string", description: "チャンネルID（例: C0123456789）" }, text: { type: "string" } }, ["channel", "text"]),
        keywords: ["通知", "投稿", "送信", "報告", "連絡", "message", "post", "notify", "send", "alert"],
        scopes: ["chat:write"],
      },
      {
        name: "slack_list_channels",
        display_name: "チャンネル一覧を取得",
        description: "参加可能なチャンネルの一覧を取得する",
        method: "GET",
        path: "/conversations.list",
        risk: "read",
        input_schema: obj({ limit: { type: "number" }, cursor: { type: "string" } }),
        keywords: ["チャンネル", "channel"],
        scopes: ["channels:read"],
        probe: true,
      },
      {
        name: "slack_channel_history",
        display_name: "チャンネルの履歴を読む",
        description: "指定したチャンネルの最近のメッセージを取得する",
        method: "GET",
        path: "/conversations.history",
        risk: "read",
        input_schema: obj({ channel: { type: "string" }, limit: { type: "number" }, oldest: { type: "string" } }, ["channel"]),
        keywords: ["履歴", "読み", "取得", "集計", "要約", "history", "read", "summar", "collect"],
        scopes: ["channels:history"],
      },
    ],
    version: 1,
  },
  {
    key: "notion",
    name: "Notion",
    description: "Notionのページやデータベースを検索・読み取りし、必要ならページを作成します。",
    match: /notion|ノーション/i,
    adapter: "http_openapi",
    base_url: "https://api.notion.com/v1",
    default_headers: { "Notion-Version": "2022-06-28" },
    auth: {
      kind: "static_bearer",
      header_name: "Authorization",
      secret_label: "Notionのインテグレーションシークレット",
      secret_help: "Notionの「インテグレーション」で内部インテグレーションを作成し、使いたいページへ接続してからシークレットを貼り付けます。",
      help_url: "https://www.notion.so/my-integrations",
    },
    operations: [
      {
        name: "notion_current_user",
        display_name: "接続を確認",
        description: "インテグレーション自身の情報を取得して接続を確認する",
        method: "GET",
        path: "/users/me",
        risk: "read",
        input_schema: obj({}),
        keywords: ["接続確認"],
        probe: true,
      },
      {
        name: "notion_search",
        display_name: "ページを検索",
        description: "タイトルでページやデータベースを検索する",
        method: "POST",
        path: "/search",
        risk: "read",
        input_schema: obj({ query: { type: "string" }, page_size: { type: "number" } }),
        keywords: ["検索", "探", "search", "find"],
      },
      {
        name: "notion_get_page",
        display_name: "ページを読む",
        description: "ページIDを指定してページの属性を取得する",
        method: "GET",
        path: "/pages/{page_id}",
        risk: "read",
        input_schema: obj({ page_id: { type: "string" } }, ["page_id"]),
        keywords: ["読", "取得", "参照", "要約", "read", "get", "fetch", "summar"],
      },
      {
        name: "notion_get_page_content",
        display_name: "ページ本文を読む",
        description: "ページ（ブロック）IDを指定して本文のブロック一覧を取得する",
        method: "GET",
        path: "/blocks/{block_id}/children",
        risk: "read",
        input_schema: obj({ block_id: { type: "string" }, page_size: { type: "number" } }, ["block_id"]),
        keywords: ["本文", "内容", "要約", "議事録", "読", "content", "body", "summar", "read"],
      },
      {
        name: "notion_query_database",
        display_name: "データベースを読む",
        description: "データベースIDを指定して行を取得する",
        method: "POST",
        path: "/databases/{database_id}/query",
        risk: "read",
        input_schema: obj({ database_id: { type: "string" }, filter: { type: "object" }, page_size: { type: "number" } }, ["database_id"]),
        keywords: ["データベース", "一覧", "database", "table", "list"],
      },
      {
        name: "notion_create_page",
        display_name: "ページを作成",
        description: "親ページまたはデータベースの下に新しいページを作る",
        method: "POST",
        path: "/pages",
        risk: "write",
        input_schema: obj({ parent: { type: "object" }, properties: { type: "object" }, children: { type: "array" } }, ["parent", "properties"]),
        keywords: ["作成", "追加", "記録", "書", "create", "add", "write", "record"],
      },
    ],
    version: 1,
  },
  {
    key: "google-drive",
    name: "Google Drive",
    description: "Google Driveのファイルを検索し、内容を読み取ります。",
    match: /google\s*drive|googleドライブ|gドライブ|ドライブ内|drive\.google/i,
    adapter: "http_openapi",
    base_url: "https://www.googleapis.com/drive/v3",
    auth: {
      kind: "oauth2",
      authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
      token_url: "https://oauth2.googleapis.com/token",
      scope_separator: " ",
      pkce: true,
      token_request: "form",
      token_auth: "body",
      access_token_path: "access_token",
      identity: { url: "https://www.googleapis.com/oauth2/v3/userinfo", id_path: "sub", label_path: "email" },
      console_url: "https://console.cloud.google.com/apis/credentials",
      header_name: "Authorization",
      extra_authorize_params: { access_type: "online", prompt: "consent" },
    },
    operations: [
      {
        name: "google_drive_list_files",
        display_name: "ファイルを検索",
        description: "名前や種類でファイルを検索する",
        method: "GET",
        path: "/files",
        risk: "read",
        input_schema: obj({ q: { type: "string", description: "Drive検索クエリ" }, pageSize: { type: "number" } }),
        keywords: ["検索", "一覧", "探", "ファイル", "search", "list", "file"],
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
        probe: true,
      },
      {
        name: "google_drive_get_file",
        display_name: "ファイル情報を読む",
        description: "ファイルIDを指定して名前・種類・更新日時を取得する",
        method: "GET",
        path: "/files/{fileId}",
        risk: "read",
        input_schema: obj({ fileId: { type: "string" }, fields: { type: "string" } }, ["fileId"]),
        keywords: ["読", "取得", "参照", "read", "get", "fetch"],
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      },
    ],
    version: 1,
  },
  {
    key: "google-sheets",
    name: "Google スプレッドシート",
    description: "Google スプレッドシートの範囲を読み取り、行を追記します。",
    match: /google\s*sheets?|スプレッドシート|spreadsheet/i,
    adapter: "http_openapi",
    base_url: "https://sheets.googleapis.com/v4",
    auth: {
      kind: "oauth2",
      authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
      token_url: "https://oauth2.googleapis.com/token",
      scope_separator: " ",
      pkce: true,
      token_request: "form",
      token_auth: "body",
      access_token_path: "access_token",
      identity: { url: "https://www.googleapis.com/oauth2/v3/userinfo", id_path: "sub", label_path: "email" },
      console_url: "https://console.cloud.google.com/apis/credentials",
      header_name: "Authorization",
      extra_authorize_params: { access_type: "online", prompt: "consent" },
    },
    operations: [
      {
        name: "google_sheets_read_range",
        display_name: "セル範囲を読む",
        description: "スプレッドシートIDと範囲（例: Sheet1!A1:D100）を指定して値を取得する",
        method: "GET",
        path: "/spreadsheets/{spreadsheetId}/values/{range}",
        risk: "read",
        input_schema: obj({ spreadsheetId: { type: "string" }, range: { type: "string" } }, ["spreadsheetId", "range"]),
        keywords: ["読", "取得", "集計", "参照", "read", "get", "sum", "aggregate"],
        scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
        probe: true,
      },
      {
        name: "google_sheets_append_rows",
        display_name: "行を追記",
        description: "指定した範囲の末尾に行を追加する",
        method: "POST",
        path: "/spreadsheets/{spreadsheetId}/values/{range}:append",
        risk: "write",
        input_schema: obj({ spreadsheetId: { type: "string" }, range: { type: "string" }, values: { type: "array" } }, ["spreadsheetId", "range", "values"]),
        keywords: ["追記", "追加", "記録", "書き込", "転記", "append", "add", "write", "record"],
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      },
    ],
    version: 1,
  },
  {
    key: "freee",
    name: "freee会計",
    description: "freee会計の事業所・取引・請求書を読み取り、必要なら取引を登録します。",
    match: /freee|フリー会計/i,
    adapter: "http_openapi",
    base_url: "https://api.freee.co.jp/api/1",
    auth: {
      kind: "oauth2",
      authorize_url: "https://accounts.secure.freee.co.jp/public_api/authorize",
      token_url: "https://accounts.secure.freee.co.jp/public_api/token",
      scope_separator: " ",
      pkce: false,
      token_request: "form",
      token_auth: "body",
      access_token_path: "access_token",
      identity: { url: "https://api.freee.co.jp/api/1/users/me", id_path: "user.id", label_path: "user.email" },
      console_url: "https://app.secure.freee.co.jp/developers/applications",
      header_name: "Authorization",
    },
    operations: [
      {
        name: "freee_get_companies",
        display_name: "事業所一覧を取得",
        description: "利用できる事業所の一覧を取得する",
        method: "GET",
        path: "/companies",
        risk: "read",
        input_schema: obj({}),
        keywords: ["事業所", "会社", "company"],
        scopes: ["read"],
        probe: true,
      },
      {
        name: "freee_list_invoices",
        display_name: "請求書一覧を取得",
        description: "事業所IDを指定して請求書の一覧を取得する",
        method: "GET",
        path: "/invoices",
        risk: "read",
        input_schema: obj({ company_id: { type: "number" }, limit: { type: "number" } }, ["company_id"]),
        keywords: ["請求", "invoice"],
        scopes: ["read"],
      },
      {
        name: "freee_list_deals",
        display_name: "取引一覧を取得",
        description: "事業所IDを指定して収入・支出の取引を取得する",
        method: "GET",
        path: "/deals",
        risk: "read",
        input_schema: obj({ company_id: { type: "number" }, start_issue_date: { type: "string" }, end_issue_date: { type: "string" }, limit: { type: "number" } }, ["company_id"]),
        keywords: ["取引", "売上", "経費", "支出", "収入", "deal", "sales", "expense"],
        scopes: ["read"],
      },
      {
        name: "freee_create_deal",
        display_name: "取引を登録",
        description: "収入または支出の取引を登録する",
        method: "POST",
        path: "/deals",
        risk: "financial",
        input_schema: obj({ company_id: { type: "number" }, issue_date: { type: "string" }, type: { type: "string" }, details: { type: "array" } }, ["company_id", "issue_date", "type", "details"]),
        keywords: ["登録", "仕訳", "計上", "記帳", "register", "create", "book"],
        scopes: ["write"],
      },
    ],
    version: 1,
  },
  {
    key: "qiita",
    name: "Qiita",
    description: "Qiita公式API v2で技術記事を公開します。",
    match: /qiita|キータ/i,
    adapter: "http_openapi",
    base_url: "https://qiita.com/api/v2",
    auth: {
      kind: "oauth2",
      authorize_url: "https://qiita.com/api/v2/oauth/authorize",
      token_url: "https://qiita.com/api/v2/access_tokens",
      scope_separator: " ",
      pkce: false,
      token_request: "json",
      token_auth: "body",
      access_token_path: "token",
      identity: { url: "https://qiita.com/api/v2/authenticated_user", id_path: "id", label_path: "id" },
      console_url: "https://qiita.com/settings/applications",
      header_name: "Authorization",
    },
    operations: [
      {
        name: "publish_qiita_article",
        display_name: "Qiita記事を公開",
        description: "タイトル、Markdown本文、タグを指定してQiitaへ技術記事を公開する",
        method: "POST",
        path: "/items",
        risk: "external_send",
        input_schema: obj({
          title: { type: "string" },
          body: { type: "string" },
          tags: { type: "array", minItems: 1, maxItems: 5, items: obj({ name: { type: "string" }, versions: { type: "array", items: { type: "string" } } }, ["name", "versions"]) },
          private: { type: "boolean" },
        }, ["title", "body", "tags"]),
        keywords: ["投稿", "公開", "記事", "publish", "post", "article"],
        scopes: ["read_qiita", "write_qiita"],
      },
      {
        name: "qiita_authenticated_user",
        display_name: "アカウントを確認",
        description: "認証中のQiitaアカウントを確認する",
        method: "GET",
        path: "/authenticated_user",
        risk: "read",
        input_schema: obj({}),
        keywords: ["アカウント", "account"],
        scopes: ["read_qiita"],
        probe: true,
      },
    ],
    version: 1,
  },
  {
    key: "social-router",
    name: "Social Router",
    description: "接続したSNSアカウント（Xなど）の投稿取得と、承認済み投稿の公開に利用します。",
    match: /(^|[^A-Za-z])X(?:アカウント)?(へ|で|に|投稿)|twitter|ツイート|公開投稿|(?:SNS|外部|非同期|アカウント).*(?:投稿|公開)|(?:投稿|公開).*(?:SNS|外部|アカウント)/i,
    adapter: "http_openapi",
    base_url: "https://d3vatrn3wuw8oq.cloudfront.net",
    auth: {
      kind: "static_bearer",
      header_name: "Authorization",
      secret_label: "Social RouterのAPIキー",
      secret_help: "Social Routerの管理画面で発行した、投稿権限付きのAPIキーを貼り付けます。",
    },
    operations: [
      {
        name: "list_accounts",
        display_name: "アカウントを確認",
        description: "接続済みSNSアカウントと利用可能な操作を取得する",
        method: "GET",
        path: "/v1/accounts",
        risk: "read",
        input_schema: obj({}),
        keywords: ["アカウント", "account"],
        probe: true,
      },
      {
        name: "list_posts",
        display_name: "過去投稿を取得",
        description: "指定した自社SNSアカウントの過去投稿を取得する",
        method: "GET",
        path: "/v1/posts",
        risk: "read",
        input_schema: obj({ account_id: { type: "string" }, limit: { type: "number" }, cursor: { type: "string" } }, ["account_id"]),
        keywords: ["過去", "履歴", "取得", "分析", "history", "past", "analy"],
      },
      {
        name: "get_post",
        display_name: "投稿詳細を取得",
        description: "自社SNS投稿の詳細と反応情報を取得する",
        method: "GET",
        path: "/v1/posts/{id}",
        risk: "read",
        input_schema: obj({ id: { type: "string" } }, ["id"]),
        keywords: ["反応", "詳細", "engagement", "detail"],
      },
      {
        name: "publish_post",
        display_name: "SNSへ公開投稿",
        description: "明示承認された本文を指定アカウントへ非同期で投稿する",
        method: "POST",
        path: "/v1/posts",
        idempotency_key_field: "logical_post_id",
        risk: "external_send",
        input_schema: obj({
          account_id: { type: "string" },
          text: { type: "string" },
          media_ids: { type: "array", items: { type: "string" } },
          logical_post_id: { type: "string" },
        }, ["account_id", "text", "logical_post_id"]),
        keywords: ["投稿", "公開", "post", "publish", "tweet"],
      },
      {
        name: "get_job",
        display_name: "投稿結果を確認",
        description: "非同期投稿Jobの状態を確認し、succeededの場合だけ成功と判断する",
        method: "GET",
        path: "/v1/jobs/{id}",
        risk: "read",
        input_schema: obj({ id: { type: "string" } }, ["id"]),
        keywords: ["投稿", "公開", "結果", "post", "publish", "job"],
      },
    ],
    version: 1,
  },
  {
    key: "browser-automation",
    name: "ブラウザ操作",
    description: "公開Webページを開き、表示内容を安全に読み取って調査や比較に利用します。",
    match: /ブラウザ|browser|スクレイピング|scrap(?:e|ing)|(?:web|ウェブ)サイト(?:を|の)?(?:開|閲覧|巡回|操作)/i,
    adapter: "runtime",
    auth: { kind: "none" },
    requires_self_hosted: true,
    operations: [
      { name: "browser_navigate", display_name: "Webページを開く", description: "指定した公開URLをBrowserで開く", risk: "read", input_schema: obj({ url: { type: "string" } }, ["url"]), keywords: ["開", "navigate", "open"], probe: true },
      { name: "browser_snapshot", display_name: "ページ内容を読み取る", description: "開いているWebページの表示内容と参照可能な要素を取得する", risk: "read", input_schema: obj({}), keywords: ["読", "snapshot", "read"] },
      { name: "browser_screenshot", display_name: "画面を確認", description: "現在のブラウザ画面を元の解像度で取得する", risk: "read", input_schema: obj({ full_page: { type: "boolean" } }), keywords: ["画面", "screenshot"] },
      { name: "browser_wait_for", display_name: "表示を待つ", description: "ページ内の文字や要素が表示されるまで待つ", risk: "read", input_schema: obj({ text: { type: "string" }, selector: { type: "string" }, timeout_ms: { type: "number" } }), keywords: ["待", "wait"] },
      ...([
        ["browser_tabs", "タブを操作", "タブを一覧・選択・閉じる"],
        ["browser_click", "画面をクリック", "画面上の要素をクリックする"],
        ["browser_type", "文字を入力", "入力欄へ文字列を入力する"],
        ["browser_press_key", "キーを入力", "現在の画面へキー入力する"],
        ["browser_select_option", "選択肢を変更", "選択項目の値を変更する"],
        ["browser_hover", "要素を確認", "要素へマウスを重ねる"],
        ["browser_drag", "要素を移動", "要素間をドラッグする"],
        ["browser_exec_js", "複数画面を調査", "公開ページを制限付きPlaywrightコードで操作する"],
      ] as const).map(([name, display_name, description]): CatalogOperation => ({
        name,
        display_name,
        description,
        risk: "write",
        input_schema: { type: "object", properties: {}, additionalProperties: true },
        keywords: ["操作", "入力", "クリック", "click", "type", "operate", "fill"],
      })),
    ],
    version: 1,
  },
  {
    key: "github",
    name: "GitHub",
    description: "GitHub Appで会社専用のRepositoryへ変更を提案します（設定 > 詳細設定で接続）。",
    match: /github|ギットハブ/i,
    adapter: "http_openapi",
    base_url: "https://api.github.com",
    auth: { kind: "github_app" },
    operations: [],
    version: 1,
  },
];

/** カタログに定義はないが「外部SaaS」として扱う名前。実装先の分類（capability-fulfillment）で使う */
const KNOWN_SAAS_PATTERN = /kintone|salesforce|jira|confluence|microsoft(?:\s+365| teams| outlook)?|supabase|stripe|shopify|zendesk|hubspot|moneyforward|マネーフォワード|スマレジ|google(?:\s+workspace| calendar)?/i;

/** 依頼文・要件文に一致するカタログエントリ（GitHub App 委譲を含む）。 */
export function matchProviders(text: string): ProviderCatalogEntry[] {
  return PROVIDER_CATALOG.filter((entry) => entry.match.test(text));
}

/** Connector の登録キーからカタログエントリを引く。手動登録の Qiita など旧データは key で後方互換にする。 */
export function catalogEntryFor(connector: { key: string; provider_key?: string | null }): ProviderCatalogEntry | null {
  const key = connector.provider_key ?? connector.key;
  return PROVIDER_CATALOG.find((entry) => entry.key === key) ?? null;
}

/**
 * 要件文に関係する操作だけを選ぶ。probe 操作（read の代表操作）は接続テストのため常に含める。
 * どの操作にも一致しなければ read 操作をすべて返し、書き込みは登録しない。
 */
export function selectOperations(entry: ProviderCatalogEntry, requirementTexts: string[]): CatalogOperation[] {
  const text = requirementTexts.join("\n").toLowerCase();
  const matched = entry.operations.filter((operation) => operation.keywords.some((keyword) => text.includes(keyword.toLowerCase())));
  const probes = entry.operations.filter((operation) => operation.probe);
  const chosen = matched.length ? [...matched, ...probes] : [...entry.operations.filter((operation) => operation.risk === "read"), ...probes];
  const seen = new Set<string>();
  return entry.operations.filter((operation) => {
    if (!chosen.includes(operation) || seen.has(operation.name)) return false;
    seen.add(operation.name);
    return true;
  });
}

/** 登録済み操作に必要な最小 scope の和集合。 */
export function minimalScopes(entry: ProviderCatalogEntry, operationNames: string[]): string[] {
  const names = new Set(operationNames);
  return [...new Set(entry.operations.filter((operation) => names.has(operation.name)).flatMap((operation) => operation.scopes ?? []))];
}

/** createConnector へ渡す形（keywords などカタログ専用の項目を落とす）。 */
export function toConnectorOperation(operation: CatalogOperation): ConnectorOperationInput {
  const { keywords: _keywords, scopes: _scopes, probe: _probe, ...rest } = operation;
  return rest;
}

/** 実装先の分類に使う「外部サービス名」のパターン。カタログを唯一の真実にする。 */
export function providerMatchPattern(): RegExp {
  const sources = [...PROVIDER_CATALOG.filter((entry) => entry.key !== "browser-automation").map((entry) => entry.match.source), KNOWN_SAAS_PATTERN.source];
  return new RegExp(sources.map((source) => `(?:${source})`).join("|"), "i");
}

export function connectorAuthTypeFor(entry: ProviderCatalogEntry): "none" | "static_bearer" {
  return entry.auth.kind === "none" ? "none" : "static_bearer";
}

export function toCatalogEntryDto(entry: ProviderCatalogEntry, connectorId: string | null): ProviderCatalogEntryDto {
  return {
    key: entry.key,
    name: entry.name,
    description: entry.description,
    auth_kind: entry.auth.kind,
    requires_self_hosted: entry.requires_self_hosted === true,
    connector_id: connectorId,
    oauth_console_url: entry.auth.kind === "oauth2" ? entry.auth.console_url : null,
  };
}

/** `a.b.c` 形式のパスで JSON から値を取り出す（OAuth の identity 応答用）。 */
export function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => (current && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined), value);
}
