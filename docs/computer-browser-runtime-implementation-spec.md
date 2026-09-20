# Computer / Browser Runtime 追加実装仕様書

| 項目 | 内容 |
|---|---|
| 文書バージョン | v0.1 |
| 作成日 | 2026-09-20 |
| 対象 | Agent Studio / Company Runtime |
| 目的 | Browser Use / Computer Use を主要ユースケースとして、安全かつ継続的に実行できるようにする |
| 実装方針 | 既存の Terraform、ECS、Session Worker、Tool Gateway、Playwright MCP を再利用し、不足部分を追加する |

---

## 1. 結論

Agent StudioのBrowser / Computer機能は、次の構成を標準とする。

```text
Agent Studio Control Plane
  │
  │ OpenAI Agents API
  ▼
OpenAI Agent Harness
  │
  │ outbound WebSocket
  ▼
Session Worker（Runごと）
  │
  │ session-scoped MCP token
  ▼
Tool Gateway
  │
  ├─ 通常のHTTP / MCP Tool
  │
  └─ Browser Tools
       │
       ▼
     Browser Session Worker（Runごと）
       ├ Chromium
       ├ Playwright
       ├ Screenshot
       ├ Browser actions
       └ 制限付きコード実行
            │
            ▼
       Egress Proxy / Network Policy
            │
            ▼
       許可されたWebサイト
```

役割分担は次のとおりとする。

- **Terraform**: VPC、ECS、IAM、KMS、S3、Secrets Manager、ログ、通信制御を管理する。
- **Dockerfile**: Chromium、Playwright、画面操作用依存関係、Runtimeサービスのバージョンを固定する。
- **Runtime Controller**: RunごとのBrowser Session Workerを起動・停止・監視する。
- **Tool Gateway**: Agentに見せるBrowser Tool、承認、利用制限、監査を強制する。
- **Browser Session Worker**: 実際のブラウザ状態を保持し、操作とスクリーンショットを実行する。
- **Agent Studio UI**: 内部Toolを大量に見せず、「ブラウザ操作」という1つの能力として扱う。

OpenAI公式ドキュメントでは、Computer Useについて、分離された実行環境でPlaywright等を実行し、ツール呼び出し間でブラウザ状態を維持し、スクリーンショットを返す方式が案内されている。本仕様はこの考え方に合わせる。

参考:

- [OpenAI Docs: コンピューターの使用](https://developers.openai.com/ja-JP/api/docs/guides/tools-computer-use)
- [OpenAI Docs: Computer Use連携の実装例](https://developers.openai.com/ja-JP/api/docs/guides/tools-computer-use-integration)
- [OpenAI Docs: セルフホスト型サンドボックス](https://developers.openai.com/ja-JP/api/docs/guides/agents-api/environments/self-hosted)
- [OpenAI Docs: サンドボックスのセキュリティ](https://developers.openai.com/ja-JP/api/docs/guides/agents-api/environments/security)

---

## 2. プロダクト原則

### 2.1 Agent版Vercelとして守ること

利用者に、Playwright、MCP、ECS、Docker、Browser Contextなどを理解させない。

利用者が行う操作は次だけにする。

1. 「ブラウザを使って何をしたいか」を日本語で入力する。
2. 必要ならアクセスを許可するサイトを確認する。
3. ログインが必要なら「ブラウザを接続」する。
4. AgentをPreviewで試す。
5. 同じBuildをProductionへ昇格する。

UIでは次のように表示する。

```text
必要な連携

✓ ブラウザ操作
  公開ページの閲覧、画面操作、フォーム入力に使用します

△ ログイン接続
  このAgentはログイン済みページを使います

公開前の確認

✓ 閲覧のみの操作は自動実行
✓ 投稿・送信・購入・削除は承認が必要
```

### 2.2 内部Toolをユーザーに大量に選ばせない

Agent作成画面では、`browser_click`、`browser_type` などを個別に選択させない。

画面上の単位は **Browser Automation Connector** とし、Compilerが必要な内部能力へ展開する。

```text
Browser Automation
  ├ 閲覧
  ├ 画面操作
  ├ ファイル入出力
  ├ 公開ページ向けコード実行
  └ デスクトップ操作（将来・明示的に有効化）
```

### 2.3 Self-hostedを全Agentの必須条件にしない

以下の場合だけCompany Runtimeを使用する。

- ログイン済みブラウザを使用する。
- 顧客のPrivate Networkへ接続する。
- 独自バイナリやブラウザ拡張機能が必要である。
- 長時間または複雑なBrowser Sessionを維持する。
- 顧客AWS内でネットワークポリシーを強制する。

公開Webの簡単な確認だけなら、OpenAI ManagedまたはAgent Studio Managedの軽量実行も将来選択可能にする。

---

## 3. 現在の実装と不足

### 3.1 再利用する既存実装

- Self-hosted Session WorkerをRunごとにECS Fargateで起動する仕組み
- Runtime Controllerの起動・停止・監視
- Tool Gatewayのセッショントークン認証
- Runtime側とAgent Studio側の二重Tool許可リスト
- Toolリスク、承認、監査ログ
- Playwright MCPを動かすBrowser Workerイメージ
- MCP接続をAgent Session単位で分離する`UpstreamSessionPool`
- Secrets ManagerとKMS
- DNS Firewall
- Preview / Production、Build、Deployment、Rollback

### 3.2 追加が必要なもの

| ID | 不足 | 対応 |
|---|---|---|
| GAP-01 | Browser Workerが企業ごとの常駐共有サービス | Browser Session WorkerをRunごとに起動する |
| GAP-02 | 公開Toolが少なく、複雑な操作に弱い | 安全なBrowser Action群と制限付きコード実行を追加する |
| GAP-03 | Screenshotを第一級の画像観測として扱っていない | `detail: original`相当の画像出力を扱う |
| GAP-04 | Browser状態の再接続・復旧契約が弱い | Session IDとBrowser Taskを対応付け、状態を監視する |
| GAP-05 | ログイン状態を永続化できない | 暗号化Browser Profile Storeを追加する |
| GAP-06 | 人間がMFAログインする導線がない | 一時的なBrowser Login Sessionを追加する |
| GAP-07 | DNS Firewallだけでは直接IP通信を防げない | Egress ProxyまたはNetwork Firewallを追加する |
| GAP-08 | Built-in Computer Toolを処理するループがない | Adapter境界を作り、安定したSDK対応後に追加可能にする |
| GAP-09 | AWS上の実OpenAI + Browser E2Eが未確認 | production-like E2Eを必須化する |

---

## 4. 採用する実行方式

### 4.1 優先順位

Browser操作は次の順番で使用する。

1. **Browser Action Tool**
   - 定型操作、ログイン済み画面、外部へ影響する操作に使用する。
   - Tool Gatewayが操作単位でリスクと承認を判定できる。
2. **制限付きPlaywrightコード実行**
   - 公開Webの調査、複数画面の巡回、DOM解析などに使用する。
   - 1回の呼び出しでループや条件分岐を実行できる。
3. **Computer Action Adapter**
   - Canvas、リモートデスクトップ、座標ベースでしか操作できない画面に使用する。
   - 実装タスクのPhase 5で追加する。
4. **既存Playwright MCP**
   - 移行期間と定型操作の互換レイヤーとして残す。

### 4.2 認証済みブラウザと任意コードを同じ権限にしない

Browser Sessionには2種類のモードを設ける。

| モード | 用途 | ログインProfile | コード実行 |
|---|---|---:|---:|
| `public_ephemeral` | 公開ページの分析・テスト | 不可 | 可 |
| `authenticated_restricted` | SNS、ERP、管理画面 | 可 | 原則不可 |

理由:

- ログイン済みContextへ任意コードを与えると、Cookieやページ上の機密情報へアクセスできる可能性がある。
- 認証済み画面では、許可されたBrowser Actionだけを公開する。
- 高度なコード実行が必要な認証済み用途は、管理者が明示的に有効化し、操作ごとに承認を要求する。

### 4.3 現時点ではRuntime MCPとして提供する

現在のAgents SDK統合では、Browser機能をTool Gateway配下のRuntime MCPとして提供する。

- Agent Manifestの公開形式を増やさない。
- Browser Toolも既存の`runtime_tools`へコンパイルする。
- Built-in `computer`への依存はMVPの必須条件にしない。
- 将来のSDK対応は`ComputerAdapter`として追加し、Browser Runtime本体を再利用する。

---

## 5. 目標アーキテクチャ

```text
Company Runtime VPC

┌──────────────────────────────────────────────────────────────┐
│ Runtime Core                                                 │
│                                                              │
│ Runtime Controller                                           │
│  ├ start_session                                             │
│  ├ start_browser_session                                     │
│  ├ stop_browser_session                                      │
│  ├ ECS Task監視                                               │
│  └ Browser endpointをSession Grantへ登録                      │
│                                                              │
│ Tool Gateway                                                 │
│  ├ session token検証                                         │
│  ├ allowed_tools                                             │
│  ├ policy / approval                                         │
│  ├ audit                                                     │
│  └ Session Grantのbrowser_endpointへMCP接続                  │
└──────────────────────┬───────────────────────────────────────┘
                       │
                       │ MCP / internal HTTP
                       ▼
┌──────────────────────────────────────────────────────────────┐
│ Browser Session Worker（RunごとのFargate Task）              │
│                                                              │
│ Chromium + Playwright                                        │
│  ├ Browser Context                                           │
│  ├ page / tabs                                               │
│  ├ screenshots                                               │
│  ├ downloads                                                 │
│  ├ restricted code runtime                                   │
│  └ optional authenticated profile                            │
│                                                              │
│ AWS Task Role: なし                                          │
│ Secret: なし                                                 │
│ Root filesystem: read-only                                   │
│ Temporary storage: session専用                               │
└──────────────────────┬───────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────┐
│ Egress Proxy                                                 │
│  ├ FQDN allowlist                                            │
│  ├ direct IP deny                                            │
│  ├ request metadata log                                      │
│  └ private / link-local / metadata endpoint deny             │
└──────────────────────────────────────────────────────────────┘
```

### 5.1 Browser Workerの単位

- Browser Session WorkerはAgent Studioの`agent_session`ごとに1タスクとする。
- 同一Run内のTool呼び出しでは同じBrowser Contextを再利用する。
- 別Run、別Agent、別Organizationとは共有しない。
- 最大寿命、アイドルタイムアウト、最大操作数を持つ。
- Run終了、取消、期限切れ時に必ず停止する。
- Orphan Sweeperが取り残されたTaskを停止する。

### 5.2 Browser endpointの解決

Runtimeの固定`config.yaml`へRun固有IPを書かない。

1. ControllerがBrowser Session Workerを起動する。
2. ECS TaskのPrivate IPを取得する。
3. Session Grantへ`browser_endpoint`を保持する。
4. Tool Gatewayが呼び出し時にGrantから接続先を解決する。
5. Browser TaskのSecurity GroupはRuntime Coreからの受信だけ許可する。

### 5.3 障害時

- Browser Taskが終了した場合、そのRunのBrowser Toolは`browser_session_lost`を返す。
- `public_ephemeral`は1回だけ自動再作成できる。
- `authenticated_restricted`はProfileから再作成できる場合だけ復旧する。
- 書き込み操作の途中で切れた場合は自動再実行しない。
- 最終状態が不明な場合は、人間へ確認を求める。

---

## 6. Browser Tool仕様

### 6.1 Browser Automation Connector

表示名は「ブラウザ操作」、内部キーは`browser-automation`とする。

| Tool | 目的 | Risk | 外部コンテンツ |
|---|---|---|---:|
| `browser_navigate` | URLを開く | `read` | Yes |
| `browser_snapshot` | アクセシビリティツリーと現在状態を取得 | `read` | Yes |
| `browser_screenshot` | 現在画面を画像で取得 | `read` | Yes |
| `browser_wait_for` | 要素・文字列・時間を待つ | `read` | Yes |
| `browser_tabs` | タブの一覧・選択・クローズ | `write` | Yes |
| `browser_click` | 要素をクリック | `write` | Yes |
| `browser_type` | 入力欄へ入力 | `write` | Yes |
| `browser_press_key` | キー操作 | `write` | Yes |
| `browser_select_option` | 選択肢を変更 | `write` | Yes |
| `browser_hover` | ホバー | `write` | Yes |
| `browser_drag` | ドラッグ | `write` | Yes |
| `browser_handle_dialog` | ダイアログを許可・拒否 | `write` | Yes |
| `browser_upload` | 外部サイトへファイルを渡す | `external_send` | Yes |
| `browser_download` | ダウンロードして成果物へ保存 | `read` | Yes |
| `browser_exec_js` | 公開ページをPlaywrightコードで操作 | `write` | Yes |
| `computer_action` | 座標ベースの画面操作 | `write` | Yes |

### 6.2 デフォルトで公開しないTool

次は標準Agentへ公開しない。

- Playwright MCPの`browser_run_code_unsafe`
- 任意のNode.js `require`を許すコード実行
- Cookie一覧の取得
- Local Storage / Session Storageの全量取得
- Authorization Headerの取得
- Network response bodyの全量取得
- DevTools Protocolの無制限実行
- 任意ファイルパスの読み取り
- 任意URLへの`fetch`

### 6.3 Screenshot

- 操作前に状態が不明ならScreenshotまたはSnapshotを取得する。
- 短い操作バッチの後にScreenshotを返し、結果を確認可能にする。
- 画像は解像度を保って返す。
- 標準Viewportは`1440x900`とする。
- 画像を縮小する場合は、座標変換をRuntime側で行う。
- ScreenshotのBase64をテキストログへ出さない。
- デフォルトでは永続保存しない。
- 監査保存を有効にした場合だけ、顧客Runtime側の暗号化S3へ保存する。

### 6.4 制限付きコード実行

`browser_exec_js`は次の入力を受ける。

```json
{
  "code": "await page.goto('https://example.com'); ...",
  "timeout_ms": 30000,
  "expects": "対象ページのタイトルと主要リンクを取得する"
}
```

実行条件:

- `public_ephemeral`だけで標準有効とする。
- Browser Session Worker自体をセキュリティ境界とする。
- Browser TaskはAWS権限・Secretを持たない。
- `process`、`require`、ファイルシステム、子プロセスを公開しない。
- `page`、制限された`context`、`console.log`、`display`だけを公開する。
- 1回の最大実行時間、最大出力、最大Screenshot数を制限する。
- CPU・メモリ・一時ディスク・ネットワークを制限する。
- 実行コード全文は標準監査ログへ保存せず、ハッシュと危険操作の要約を保存する。

### 6.5 Computer Action Adapter

実装タスクのPhase 5で次のActionを扱えるようにする。

- `screenshot`
- `click`
- `double_click`
- `move`
- `drag`
- `scroll`
- `type`
- `keypress`
- `wait`

AdapterはBrowser Runtimeの操作APIへ変換し、操作後のScreenshotを返す。

---

## 7. 認証済みBrowser Profile

### 7.1 Profile Store

CookieやStorage StateをAgent Studio DBへ保存しない。

```text
Agent Studio DB
  └ Browser Profileのメタデータだけ

Customer Runtime S3
  └ encrypted browser storage state
       └ SSE-KMS（tenant runtime key）
```

DBへ保存する項目:

- Profile ID
- Organization ID
- Connection ID
- Runtime ID
- 表示名
- 許可ドメイン
- 状態（pending / active / expired / revoked）
- Runtime側Object Key
- 最終確認時刻
- 有効期限
- 作成者・更新者

Cookie、Token、Storage State本体は保存しない。

### 7.2 人間によるログイン

```text
利用者
  ↓ 「ブラウザを接続」
Agent Studio
  ↓ login_session job
Customer Runtime
  ↓ 一時Browser Login Worker
利用者が画面上でログイン / MFA
  ↓
Storage Stateを暗号化保存
  ↓
Browser Profileをactiveへ変更
```

要件:

- Runtimeへの新規パブリックInboundは作らない。
- Login WorkerからAgent Studioの認証済みRelayへOutbound WebSocketを張る。
- Relay URLは短期・一度限り・利用者とOrganizationに束縛する。
- PasswordやMFAコードをAgentの会話、Runイベント、監査本文へ保存しない。
- Login Sessionは15分で失効する。
- Profileの利用先ドメインをログイン時に固定する。
- Profileの更新・失効・削除を画面から実行できる。

### 7.3 Profile利用時の制限

- `authenticated_restricted`では任意コード実行を標準無効にする。
- Cookie、Storage、認証Headerを返すToolは登録しない。
- Profileに設定されたドメイン以外へ遷移させない。
- 投稿、送信、購入、削除、権限変更は必ず承認対象とする。
- 外部ページの内容を読んだ後の書き込みは、既存のPOL-07を適用する。

---

## 8. セキュリティ仕様

### 8.1 Trust Boundary

| コンポーネント | 扱い | Secret | AWS権限 |
|---|---|---|---|
| Session Worker | Untrusted | Environment Keyのみ | なし |
| Browser Session Worker | Untrusted | 直接保持しない | なし |
| Tool Gateway | Trusted | Connection参照可能 | 必要最小限 |
| Runtime Controller | Trusted | Environment Key管理 | ECS操作等 |
| Browser Profile Broker | Trusted | Profile復号可能 | Profile Storeだけ |

### 8.2 Egress制御

DNS Firewallだけをセキュリティ境界にしない。

標準構成:

1. Browser Session WorkerのSecurity Groupから`0.0.0.0/0:80/443`を削除する。
2. Browser Session WorkerはEgress Proxyへだけ接続可能にする。
3. Egress ProxyがFQDN allowlistを強制する。
4. 直接IP、Private IP、Link-local、AWS Metadata Endpointを拒否する。
5. ChromiumのQUICを無効化する。
6. DNS Firewallも補助防御として残す。
7. 顧客要件が高い場合はAWS Network Firewallへ切り替え可能にする。

最低限拒否するアドレス:

- `127.0.0.0/8`
- `169.254.0.0/16`
- RFC1918（明示許可した社内CIDRを除く）
- VPC Router / Resolverの不要ポート
- AWS Instance Metadata
- Organization外のRuntime内部アドレス

### 8.3 Tool承認

次は必ず承認対象とする。

- SNS投稿
- メール送信
- フォーム送信
- 購入・決済
- 金額変更
- ファイルアップロード
- レコード更新・削除
- 権限・アカウント設定変更
- MFA回避やセキュリティ設定変更につながる操作

Browser上の単純な`click`を一律承認するのではなく、Agentが実行する業務上の外部影響で判定する。

ただしRuntimeが操作の意味を判別できない場合は、承認側へ倒す。

### 8.4 ダウンロード・アップロード

- DownloadはRun専用ディレクトリへ保存する。
- ファイル名を正規化し、親ディレクトリ参照を拒否する。
- サイズ上限を設ける。
- MIME Typeと拡張子を検証する。
- 実行可能ファイルは自動実行しない。
- UploadはAgent Studioの成果物IDを指定し、任意パスを受け取らない。
- Uploadは`external_send`として承認を要求する。

### 8.5 ログ

保存する:

- Session ID / Run ID
- Tool名
- 引数ハッシュ
- 対象Origin
- Policy判定
- Approval ID
- 結果ステータス
- 実行時間
- Browser Task ARN

標準では保存しない:

- Password
- Cookie
- Authorization Header
- MFAコード
- ScreenshotのBase64
- 入力フォームの秘密値
- HTML全文

---

## 9. Terraform追加仕様

### 9.1 追加変数

`infra/modules/tenant-runtime/variables.tf`へ次を追加する。

```hcl
variable "browser_runtime" {
  type = object({
    enabled                    = optional(bool, false)
    session_isolation          = optional(string, "fargate_task")
    cpu                        = optional(number, 2048)
    memory                     = optional(number, 4096)
    ephemeral_storage_gib      = optional(number, 30)
    max_concurrent_sessions    = optional(number, 10)
    max_lifetime_minutes       = optional(number, 120)
    idle_timeout_minutes       = optional(number, 15)
    code_execution_enabled     = optional(bool, true)
    authenticated_profiles     = optional(bool, false)
    computer_actions_enabled   = optional(bool, false)
    screenshot_audit_enabled   = optional(bool, false)
  })
  default = {}
}

variable "egress_policy" {
  type = object({
    mode            = optional(string, "proxy")
    allowed_domains = optional(list(string), [])
  })
  default = {}
}
```

既存の`browser_enabled`は移行期間だけ残し、`browser_runtime.enabled`へ読み替える。移行完了後に削除する。

### 9.2 追加AWSリソース

- Browser Session Worker用ECS Task Definition
- Browser Session Worker用Security Group
- Browser Session Worker用CloudWatch Log Group
- Browser Session Worker用Task Role（権限なし）
- Browser Session Worker用Execution Role
- Egress Proxy ECS ServiceまたはAWS Network Firewall
- Egress Proxy用Security Group
- Browser Profile用S3 Bucket
- Browser Profile用KMS KeyまたはRuntime共通KMS Keyの用途追加
- Browser Profile Broker用IAM Policy
- 必要なVPC Endpoint
  - ECR API / DKR
  - S3
  - CloudWatch Logs
  - Secrets Manager
  - SSM

### 9.3 ECS設定

- `readonlyRootFilesystem = true`
- Linux capabilitiesをすべてdropする
- `privileged = false`
- 非rootユーザー
- `initProcessEnabled = true`
- Task単位のCPU / Memory制限
- Health Check
- SIGTERMでBrowser Contextを閉じる
- ECS Execは無効
- Public IPは割り当てない

---

## 10. Docker追加仕様

### 10.1 新しいコンポーネント

```text
runtime/browser-session-worker/
├ Dockerfile
├ package.json
├ src/
│  ├ index.ts
│  ├ server.ts
│  ├ session.ts
│  ├ actions.ts
│  ├ screenshot.ts
│  ├ code-runtime.ts
│  ├ downloads.ts
│  ├ policy.ts
│  └ redaction.ts
└ test/
```

### 10.2 Dockerfile

- Microsoft Playwright公式イメージをベースにする。
- バージョンを固定し、可能ならDigestも固定する。
- ChromiumとPlaywrightのRevision一致をCIで検証する。
- 不要なブラウザを含めない。
- `pwuser`で実行する。
- `/tmp`とRun専用ディレクトリ以外を書き込み不可にする。
- Browser MCP / Runtimeのバージョンを起動時に記録する。
- Image Scanと署名をCIへ追加する。

### 10.3 Viewport

標準値:

```text
width: 1440
height: 900
deviceScaleFactor: 1
locale: ja-JP
timezone: Asia/Tokyo（Environment設定で変更可能）
```

---

## 11. Contract / API変更

### 11.1 Runtime Contract

`StartSessionJob.session`へ任意のBrowser設定を追加する。

```ts
browser?: {
  enabled: boolean;
  mode: "public_ephemeral" | "authenticated_restricted";
  profile_id?: string;
  allowed_domains: string[];
  code_execution_enabled: boolean;
  computer_actions_enabled: boolean;
  viewport: { width: number; height: number };
};
```

Session Grantへ追加する。

```ts
browser?: {
  endpoint: string;
  mode: "public_ephemeral" | "authenticated_restricted";
  allowed_domains: string[];
};
```

### 11.2 Runtime Job

追加するJob Type:

- `start_browser_login`
- `stop_browser_login`
- `revoke_browser_profile`

通常のAgent Runでは、既存`start_session`の中でBrowser Sessionも起動する。

### 11.3 Agent Studio API

```text
GET    /browser-profiles
POST   /browser-profiles
GET    /browser-profiles/:id
DELETE /browser-profiles/:id
POST   /browser-profiles/:id/login-sessions
GET    /browser-login-sessions/:id
POST   /browser-login-sessions/:id/complete
POST   /browser-login-sessions/:id/cancel
```

### 11.4 DB

追加テーブル:

```text
browser_profiles
browser_login_sessions
browser_runtime_sessions
```

全テーブルに`organization_id`を持たせ、既存と同じRLS・複合外部キーを適用する。

### 11.5 Compiler

Compilerは次を行う。

1. Agent ProjectのRequirementにBrowser能力があるか判定する。
2. Browser Connectorの内部Toolを展開する。
3. Self-hosted Environmentを選択する。
4. 許可ドメインをBuildへ固定する。
5. 認証済みProfile使用時は`browser_exec_js`を除外する。
6. 外部コンテンツを読むためPOL-07を有効にする。
7. 外部影響のある操作へApprovalを追加する。

Manifestへ、ブラウザの内部Toolを手動で大量記載させることを必須にしない。

---

## 12. UI / UX仕様

### 12.1 Agent作成

利用者の入力例:

> ベンチマークアカウントの投稿をブラウザで確認し、自社の過去投稿と比較して、投稿案を作り、承認後に投稿して

Agent Studioの表示:

```text
このAgentに必要なもの

✓ Browser
  公開されているベンチマーク投稿を確認します

✓ Social Router
  自社投稿の取得と投稿に使用します

✓ 承認
  SNSへ投稿する前に確認を求めます
```

個別の`browser_click`等は通常表示しない。詳細画面でだけ確認可能にする。

### 12.2 Browser Connection

```text
Browser Connection

名前              X運用アカウント
Runtime           Sample A production
許可サイト         x.com
ログイン状態        接続済み
最終確認            2026-09-20 14:30

[再接続] [無効化] [削除]
```

### 12.3 Run画面

表示する:

- 現在のURLとOrigin
- 実行中の操作要約
- 最新Screenshot
- Browser Session状態
- 承認待ちの操作
- ダウンロード成果物
- Browser Sessionの残り時間

秘密値、Cookie、Headerは表示しない。

---

## 13. 実装タスク

> 2026-09-20時点。`[x]`はコード実装とローカル検証まで完了した項目を示す。AWS実環境のE2Eと本番反映は`CBR-045`として未完了。

### Phase 1: Browser Core

- [x] `CBR-001` ContractへBrowser Session設定と状態を追加する。
- [x] `CBR-002` `runtime/browser-session-worker`を新設する。
- [x] `CBR-003` Screenshot、Snapshot、Action APIを実装する。
- [x] `CBR-004` `public_ephemeral`向け制限付き`browser_exec_js`を実装する。
- [x] `CBR-005` Browser Session WorkerのDockerfileを作成する。
- [x] `CBR-006` ControllerからRunごとにBrowser Taskを起動・停止する。
- [x] `CBR-007` Browser TaskのPrivate IPをSession Grantへ追加する。
- [x] `CBR-008` Tool Gatewayを動的Browser endpointへ接続させる。
- [x] `CBR-009` Browser Toolの許可リスト、リスク、監査を追加する。
- [x] `CBR-010` Run終了時とOrphan SweeperでBrowser Taskを停止する。

### Phase 2: Network / Security

- [x] `CBR-011` Egress ProxyをTerraformで追加する。
- [x] `CBR-012` Browser Taskから直接Internetへ出られるSGルールを削除する。
- [x] `CBR-013` FQDN allowlist、direct IP deny、Private IP denyを実装する。
- [x] `CBR-014` ChromiumのQUICを無効化する。
- [x] `CBR-015` Browser Taskをread-only root filesystem、権限なしで実行する。
- [ ] `CBR-016` Upload / Downloadの検証と上限を実装する。
- [ ] `CBR-017` Secret、Cookie、Header、Screenshot Base64のログRedactionを追加する。
- [x] `CBR-018` Browser Toolの承認ルールを追加する。

### Phase 3: Browser Profile / Human Login

- [ ] `CBR-019` Browser Profile用DBテーブルとRLSを追加する。
- [ ] `CBR-020` 暗号化Profile StoreをTerraformで追加する。
- [ ] `CBR-021` Browser Profile BrokerをRuntimeへ追加する。
- [ ] `CBR-022` Login Session Jobと一時Browser Taskを追加する。
- [ ] `CBR-023` Outbound WebSocket型Login Relayを追加する。
- [ ] `CBR-024` 「ブラウザを接続」画面を実装する。
- [ ] `CBR-025` Profileの再接続・失効・削除を実装する。
- [x] `CBR-026` `authenticated_restricted`で任意コードを無効化する。

### Phase 4: Agent版Vercel UX

- [x] `CBR-027` Browser Automation Connectorを1サービスとして登録する。
- [x] `CBR-028` Capability ResolverにBrowser要件の判定を追加する。
- [x] `CBR-029` 内部Browser ToolをBuild時に自動展開する。
- [ ] `CBR-030` Agent作成時に必要なConnectionと許可ドメインだけ確認する。
- [ ] `CBR-031` Run画面へScreenshotとBrowser状態を追加する。
- [x] `CBR-032` Preview成功後、同一BuildをProductionへ昇格できることを確認する。

### Phase 5: Computer Action

- [ ] `CBR-033` `ComputerAdapter` interfaceを追加する。
- [ ] `CBR-034` click / type / scroll / drag等のAction Handlerを実装する。
- [ ] `CBR-035` Action後のScreenshot返却を実装する。
- [ ] `CBR-036` 座標変換とViewport固定を実装する。
- [ ] `CBR-037` UI状態不明時の再観測を実装する。
- [ ] `CBR-038` SDKが安定対応した時点でBuilt-in `computer`とのAdapterを追加する。

### Phase 6: 検証

- [ ] `CBR-039` 2つの同時RunでCookie・Tab・Downloadが混ざらないことを確認する。
- [x] `CBR-040` 許可外ドメインと直接IPへの通信が失敗することを確認する。
- [ ] `CBR-041` Prompt Injectionを含むページから未承認投稿できないことを確認する。
- [ ] `CBR-042` Browser Task停止後に自動再実行で二重投稿しないことを確認する。
- [ ] `CBR-043` Profile失効後にログイン済み画面へ入れないことを確認する。
- [ ] `CBR-044` Password、Cookie、MFAコードがDB・ログへ残らないことを確認する。
- [ ] `CBR-045` AWS上の実OpenAI Session + Session Worker + Tool Gateway + Browser TaskでE2Eを行う。
- [ ] `CBR-046` 長時間操作、タイムアウト、キャンセル、Orphan Cleanupを負荷試験する。

---

## 14. テスト仕様

### 14.1 Unit Test

- Browser Tool入力Schema
- Domain allowlist判定
- URL正規化
- Private IP / Link-local拒否
- Profile modeによるTool除外
- Approval判定
- Screenshot Redaction
- Downloadパス正規化
- Session timeout

### 14.2 Integration Test

- ControllerがSession WorkerとBrowser Workerを1組で起動する。
- Tool Gatewayが正しいBrowser endpointへ接続する。
- 他Sessionのendpointを利用できない。
- Browser TaskにAWS権限がない。
- Profile本体をAgent Studio APIから取得できない。
- Run取消時に両方のTaskが停止する。

### 14.3 E2E Test

#### 公開Web分析

1. AgentへベンチマークURLを渡す。
2. Browserで複数ページを巡回する。
3. SnapshotとScreenshotを使って内容を確認する。
4. 取得できない情報を推測しない。
5. 出典URLと取得時刻を残す。

#### SNS投稿

1. Browserで公開情報を読む。
2. Social Routerから自社過去投稿を取得する。
3. 投稿案を作成する。
4. 投稿前に承認待ちになる。
5. 承認前は外部投稿がない。
6. 承認後に1回だけ投稿する。
7. Job結果を取得して成功を確認する。

#### 認証済みブラウザ

1. 人間がMFAを含むログインを行う。
2. Profileを保存する。
3. 新しいRunでProfileを復元する。
4. AgentはCookie値を取得できない。
5. 許可ドメイン外へ移動できない。
6. Profile失効後は再利用できない。

---

## 15. 受け入れ条件

次をすべて満たしたときに完成とする。

1. Browserを使うAgentを日本語だけで作成できる。
2. 利用者が個別Browser Toolを手動選択しなくてよい。
3. RunごとにBrowser Sessionが分離される。
4. 同一Runではブラウザ状態が操作間で維持される。
5. Screenshotを使って操作結果を確認できる。
6. 公開Webでは制限付きPlaywrightコード実行が利用できる。
7. 認証済みProfileでは任意コードが標準無効である。
8. Cookie、Password、MFAコードがAgent Studio DBとログへ保存されない。
9. 許可外ドメインと直接IP通信がインフラ側で拒否される。
10. 外部送信・投稿・購入・削除は承認前に実行されない。
11. Run終了時にBrowser Taskが停止する。
12. AWS上の実OpenAI E2Eが成功する。
13. Previewで確認した同一BuildをProductionへ昇格できる。
14. ロールバック後も以前のBrowser設定とTool構成へ戻せる。

---

## 16. 実装順序

推奨順序は次のとおり。

```text
1. RunごとのBrowser Session Worker
   ↓
2. Tool Gatewayの動的ルーティング
   ↓
3. Screenshot + Browser Action + 公開Web向けコード実行
   ↓
4. Egress Proxyと直接IP遮断
   ↓
5. Agent Creatorの自動Capability解決
   ↓
6. AWS実E2E
   ↓
7. Browser Profile / 人間ログイン
   ↓
8. Computer Action Adapter
```

最初からHuman Login、VNC、Desktop操作を同時に作らない。まず公開Webとセッション分離を完成させ、次に認証済みブラウザ、最後に座標ベースのComputer Useを追加する。

---

## 17. 今回実装しないもの

- CAPTCHAの自動回避
- MFAの自動回避
- Bot対策の回避
- OS全体を自由に操作できる無制限Desktop
- AgentへのPassword / Cookie直接公開
- 承認なしの購入・投稿・削除
- Browser Profileの企業間共有
- 不明な状態からの書き込み操作の自動再実行

---

## 18. 最終的な利用者体験

```text
利用者:
「このアカウントの投稿を分析して、過去実績と比較し、毎朝投稿案を作って。投稿前には確認して」

Agent Studio:
  必要な能力を検出
  ├ Browser
  ├ Social Router
  └ Approval

利用者:
  [接続する] → [Previewする] → [公開する]

内部:
  Terraformが安全なAWS基盤を提供
  Dockerが実行環境を固定
  Browser SessionがRunごとに分離
  Tool Gatewayが認証・承認・監査を強制
```

利用者にはVercelのDeploymentに近い体験を提供し、複雑なBrowser Runtimeとセキュリティ制御はAgent Studio側へ隠す。
