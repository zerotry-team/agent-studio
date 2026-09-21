# Agent Studio Builder Agent 要件定義書 v0.1

更新日: 2026-09-21

## 0. この文書の位置づけ

本書は、利用者が自然言語で業務を説明すると、Agent Studio自身が必要なAgent、Workflow、Connector、Tool、Connection設定、Runtime設定を設計し、不足実装を作成・検証してPreviewまで到達させる **Agent Studio Builder Agent**（以下、Builder Agent）の要件を定義する。

既存の [Agent Studio要件定義書](requirements.md)、[Agent版Vercel実装計画](tool-integrations-social-router-implementation-plan.md)、[Computer / Browser Runtime仕様](computer-browser-runtime-implementation-spec.md)を前提とする。既存のAgent Project、Immutable Build、Preview / Production、Tool Gateway、Policy、Approval、Auditの境界は変更せず、その手前に「不足能力を実装して完成させる層」を追加する。

要件IDの接頭辞:

- `BA-GOAL`: 目的・完成条件
- `BA-INT`: 依頼受付・要件理解
- `BA-PLAN`: 能力分解・計画
- `BA-DISC`: 外部仕様・既存資産の調査
- `BA-GEN`: Connector・Tool・コード生成
- `BA-AUTH`: 認証・Connection準備
- `BA-INFRA`: Self-hosted・インフラ準備
- `BA-WF`: Workflow生成
- `BA-TEST`: 検証・デバッグ
- `BA-REL`: Build・Preview・Production
- `BA-HUMAN`: 人間専用操作
- `BA-SEC`: セキュリティ
- `BA-AUD`: 証跡・説明可能性
- `BA-UX`: 画面・利用体験
- `BA-NFR`: 非機能

---

## 1. 結論とプロダクト原則

### 1.1 North Star

利用者は「何を自動化したいか」と業務上の判断基準を説明するだけでよい。Builder Agentは、既存能力の再利用、不足能力の実装、認証準備、Preview実行、失敗時の修正まで自律的に進める。

利用者へ依頼するのは、次の **人間にしかできない操作** に限定する。

1. 規約同意、OAuth同意、MFA、CAPTCHA、Human Login
2. APIキー・Client SecretなどのSecret入力
3. 顧客AWS・社内ネットワーク・外部サービスの管理者承認
4. 業務ルール、法務・コンプライアンス判断の確定
5. 高リスクな実データ操作とProduction公開の承認

### 1.2 完成の定義

Agent定義やコードを保存しただけでは完成としない。

Builder Agentの仕事は、次のすべてを満たして初めて `ready_for_production` とする。

1. 必要な能力がすべてTool / Workflow / Policyへ解決されている
2. Secretを除く設定と実装がBuildへ固定されている
3. Preview用ConnectionとRuntimeが接続済みである
4. 自動テスト、契約テスト、セキュリティ検査が成功している
5. 実際のPreview Runが終端状態まで完了している
6. Tool Call、外部作用、成果物、判断根拠を証跡として確認できる
7. 失敗系、承認待ち、再試行、冪等性、Rollbackを確認している
8. 残る人間操作と既知の制約が明示されている

Productionは、Adminによる明示承認後に、Previewで検証した同一Buildを再生成せず昇格する。

### 1.3 Builder Agentと業務Agentを分離する

```text
Builder Agent
  ├ 業務要件を理解する
  ├ 連携方法を調査する
  ├ Connector / Tool / Backend / Workflowを作る
  ├ テスト・ブラウザ確認・デバッグを行う
  └ Preview Buildを完成させる

業務Agent
  ├ 完成したBuildだけを使う
  ├ 許可されたConnectionとToolだけを使う
  └ 日々の業務を実行する
```

Builder Agentに本番業務データへの恒久アクセスや、無制限のProduction変更権限を持たせない。

---

## 2. 背景と現在との差

現在のAgent Builderは、自然言語の依頼を必要能力へ分解し、登録済みConnector / Toolへ解決できる。不足能力は `missing`、候補が曖昧なら `ambiguous`、認証不足なら `needs_connection` として停止する。

Builder Agentは、この停止点から先を担当する。

| 状況 | 現在 | Builder Agent導入後 |
|---|---|---|
| 登録済みToolがある | 選択してBuild可能 | そのまま再利用 |
| Connectionがない | 利用者が設定 | 設定方法を生成し、安全な入力画面を出して再開 |
| OAuthアプリがない | 個別実装が必要 | Provider Setup Planを生成し、可能なら自動登録、人間専用操作だけ依頼 |
| OpenAPIはあるがConnectorがない | 手動登録 | 仕様取得、Connector生成、契約テストまで自動化 |
| APIがなくWeb画面だけ | 手動Browser設計 | Browser Flowを生成し、許可ドメイン・Human Login・回帰テストを準備 |
| 独自バックエンドが必要 | 開発者が実装 | 隔離Workspaceでコード生成、テスト、Previewデプロイ |
| 顧客AWSが必要 | 運用者がTerraform設定 | 計画と差分を生成し、承認後に適用・接続確認 |
| Previewで失敗 | 人がログを読んで修正 | Builder Agentが原因分類、修正、再テスト |

---

## 3. 想定利用者と権限

| アクター | 主な操作 |
|---|---|
| Owner | Provider共通設定、組織共通Secret、Builder Agentの実装権限、Production承認 |
| Admin | Connection、Runtime、Policy、PreviewからProductionへの昇格 |
| Builder | 業務説明、要件確認、Preview作成、生成差分の確認 |
| Operator | 完成済み業務Agentの実行 |
| Security / Compliance Reviewer | データフロー、外部送信、認証、判断ルールの承認 |
| AWS / Network Administrator | 顧客AWSへのRuntime導入、VPC接続、Secrets登録 |
| Builder Agent | 許可されたWorkspace・Preview環境内での調査、生成、テスト、修正 |

Builder Agentの権限は、通常の業務Agentと別のロール・Policyで管理する。

---

## 4. 全体アーキテクチャ

```text
利用者
  │ 自然言語の業務説明 + 型付きInput例 + 判断基準
  ▼
Builder Orchestrator（Control Plane）
  ├ Requirement Planner
  ├ Capability Resolver
  ├ Discovery Agent
  ├ Connector Generator
  ├ Workflow / Policy Generator
  ├ Code Agent
  ├ Test / Debug Agent
  ├ Provider Setup Manager
  └ Release Manager
       │
       ├ 既存Agent Studio API
       │   ├ Connector / Tool Registry
       │   ├ Connection / Secret Store
       │   ├ Agent / Workflow / Build / Deployment
       │   └ Run / Approval / Audit / Eval
       │
       ├ Isolated Builder Workspace
       │   ├ Git worktree / branch
       │   ├ shell / filesystem
       │   ├ test runner / linter / scanner
       │   └ artifact / diff / SBOM
       │
       ├ Browser Setup Session
       │   ├ Provider管理画面
       │   ├ OAuth / Human Login
       │   └ screenshot / snapshot / setup evidence
       │
       └ Company Runtime
           ├ Tool Gateway
           ├ Browser Session Worker
           ├ Generated Adapter / MCP Server
           └ Customer DB / File Server / Internal API
```

### 4.1 主要コンポーネント

| コンポーネント | 責務 |
|---|---|
| Builder Orchestrator | 長時間の作成処理、停止・再開、状態遷移、予算、再試行を管理 |
| Requirement Planner | 自然言語を入力・出力・能力・判断・例外・人間承認へ分解 |
| Discovery Agent | Registry、OpenAPI、MCP、公式資料、既存コード、画面を調査 |
| Connector Generator | 宣言的Connector、Tool Schema、Risk、Connection要件を生成 |
| Code Agent | 宣言的設定で足りない場合のみ、Backend / MCP / Adapterコードを生成 |
| Provider Setup Manager | OAuth App、Callback URL、Scope、Secret保存、接続確認を管理 |
| Workflow Generator | 条件分岐、承認、再試行、補償処理を含むWorkflowを生成 |
| Test / Debug Agent | 自動テスト、実Preview、ログ・画面確認、原因分類、修正を反復 |
| Release Manager | Immutable Build、Preview、Production Promote、Rollbackを管理 |

---

## 5. 状態モデル

Builder ProjectはAgent Projectとは別の作成作業単位として保持する。

```text
draft
  → analyzing
  → discovering
  → planning
  → waiting_human_action
  → implementing
  → validating
  → previewing
  → ready_for_production
  → production_pending_approval
  → completed

どの状態からも:
  → blocked
  → failed
  → cancelled
```

### 5.1 状態のルール

- `waiting_human_action` は失敗ではない。必要操作、対象、理由、期限、再開条件を持つ。
- 同じ人間操作を完了した後は、利用者が改めて指示しなくても自動再開する。
- `blocked` は、自動代替経路を試しても外部条件が満たせない場合だけ使う。
- `completed` は、依頼された終端がPreviewならPreview成功、Productionなら本番昇格と本番確認まで完了した場合だけ使う。
- 途中生成物、失敗理由、再試行回数はすべて保存し、プロセス再起動後も再開できる。

---

## 6. 機能要件

### 6.1 依頼受付・業務理解（BA-INT）

| ID | 要件 | 優先度 |
|---|---|---|
| BA-INT-01 | 自然言語の業務説明から、目的、開始条件、入力、出力、判断、外部作用、例外を抽出する | Must |
| BA-INT-02 | JSON Schema、OpenAPI Schema、CSV例、PDF例、画面例を入力仕様として受け取れる | Must |
| BA-INT-03 | Secretやパスワードらしい値を通常入力から除外し、安全なSecret入力へ誘導する | Must |
| BA-INT-04 | 発見可能な技術事項を利用者へ質問しない。質問は業務判断か人間専用操作に限定する | Must |
| BA-INT-05 | 依頼の解釈を「入力・処理・出力・外部作用・承認」の図と文章で提示する | Must |
| BA-INT-06 | 高リスク領域を検出し、Compliance Reviewerを自動追加できる | Should |
| BA-INT-07 | 利用者が訂正した業務用語と判断基準をBuilder Projectへ反映する | Must |

### 6.2 能力分解・計画（BA-PLAN）

| ID | 要件 | 優先度 |
|---|---|---|
| BA-PLAN-01 | 業務をCapability Graphへ分解し、各能力の入力、出力、実行場所、Risk、Connection、依存関係を持たせる | Must |
| BA-PLAN-02 | 能力ごとに `reuse / configure / generate_declarative / generate_code / browser / unsupported` を判定する | Must |
| BA-PLAN-03 | API連携をBrowser操作より優先し、BrowserはAPIがないか契約上使えない場合だけ選ぶ | Must |
| BA-PLAN-04 | LLMが行う判断と、決定的なルールエンジンで行う判断を分離する | Must |
| BA-PLAN-05 | 書き込み、外部送信、金額変更、法的・信用判断にはPolicyとApprovalを自動提案する | Must |
| BA-PLAN-06 | 推定で業務ルールを確定しない。不明な閾値は明示的な設定値または確認事項にする | Must |
| BA-PLAN-07 | 実装順、テスト順、Human Gate、Rollbackを含む実行計画を生成する | Must |

### 6.3 調査（BA-DISC）

調査の優先順位を固定する。

1. 組織内の既存Connector / Tool / Template
2. MCPの`tools/list`と入力Schema
3. 提供されたOpenAPI / JSON Schema
4. 公式API資料・公式SDK
5. 対象システムの読取専用メタデータAPI
6. 許可されたブラウザ画面のSnapshot
7. 利用者への質問

| ID | 要件 | 優先度 |
|---|---|---|
| BA-DISC-01 | 調査したURL、仕様バージョン、取得時刻、根拠を保存する | Must |
| BA-DISC-02 | 公式仕様と推測を区別し、推測から書き込みToolを生成しない | Must |
| BA-DISC-03 | 認証方式、Scope、Rate Limit、Webhook、冪等性、Pagination、エラー形式を抽出する | Must |
| BA-DISC-04 | 顧客DBは可能ならSchemaメタデータだけ読み、業務データのサンプル取得を最小化する | Must |
| BA-DISC-05 | Web画面を調査するときは利用規約、robots、許可ドメイン、ログイン要否を記録する | Should |

### 6.4 Connector・Tool・コード生成（BA-GEN）

生成方式は次の順に選ぶ。

1. 既存Connector / Toolの再利用
2. 宣言的HTTP Connector
3. MCP Connector
4. Browser Automation Connector
5. Custom Adapter / MCP Server / Backendコード

| ID | 要件 | 優先度 |
|---|---|---|
| BA-GEN-01 | OpenAPIからOperation、入力Schema、出力Schema、Risk候補を生成する | Must |
| BA-GEN-02 | 生成Toolはバージョン管理し、既存Buildの挙動を変更しない | Must |
| BA-GEN-03 | Riskの確定はコード側ルールで行い、モデルが危険度を下げられない | Must |
| BA-GEN-04 | APIレスポンスを安定した業務Schemaへ変換するAdapterを生成できる | Must |
| BA-GEN-05 | Pagination、Rate Limit、Timeout、Retry、Idempotency-Keyを実装できる | Must |
| BA-GEN-06 | Custom Codeは組織ごとの隔離Workspaceと専用branchで生成する | Must |
| BA-GEN-07 | 生成差分、依存パッケージ、マイグレーション、Terraform差分をChange Setとして保存する | Must |
| BA-GEN-08 | Secret、個人データ、実業務データをテストfixtureやGitへ書き込まない | Must |
| BA-GEN-09 | 生成物にUnit Test、Contract Test、型、ログ、Health Checkを含める | Must |
| BA-GEN-10 | 任意コードのProduction直接反映を禁止し、必ずCIとPreviewを通す | Must |

### 6.5 認証・Connection準備（BA-AUTH）

| ID | 要件 | 優先度 |
|---|---|---|
| BA-AUTH-01 | OAuth、API Token、Static Bearer、MCP Vault、Runtime Secret、Browser Loginを識別する | Must |
| BA-AUTH-02 | OAuth Dynamic Client Registration対応Providerでは、Policyで許可された範囲で自動登録する | Should |
| BA-AUTH-03 | 自動登録不能なProviderでは、正確なCallback URL、Scope、入力欄、手順をProvider Setup Actionとして生成する | Must |
| BA-AUTH-04 | Client Secret、API Key、Tokenは書き込み専用UIからSecret Storeへ保存し、モデル・DB・ログへ値を返さない | Must |
| BA-AUTH-05 | OAuth認可コードはAPI側で交換し、Access Tokenをブラウザやモデルへ返さない | Must |
| BA-AUTH-06 | Human LoginはモデルからパスワードとMFAを見えなくする一時セッションで行う | Must |
| BA-AUTH-07 | 接続後に読取専用の最小操作でConnection Testを実行する | Must |
| BA-AUTH-08 | Scope不足、期限切れ、revoke、Provider側設定不整合を判別して修復手順を出す | Must |
| BA-AUTH-09 | ConnectionをPreview / Productionで分離し、Production SecretをPreviewで使わない | Must |

### 6.6 Self-hosted・インフラ（BA-INFRA）

| ID | 要件 | 優先度 |
|---|---|---|
| BA-INFRA-01 | データ分類と接続先から、OpenAI-hosted / Agent Studio管理AWS / 顧客AWSを提案する | Must |
| BA-INFRA-02 | 社内DB、社内ファイルサーバー、Private APIは原則Self-hosted Runtimeから接続する | Must |
| BA-INFRA-03 | Runtime設定、Tool Gateway設定、許可ドメイン、Secret参照を生成する | Must |
| BA-INFRA-04 | Terraformの`plan`は自動作成できるが、production `apply`はAdmin承認を必須にする | Must |
| BA-INFRA-05 | 顧客AWSへのBootstrap、IAM、VPC接続、Secrets登録をSetup Actionとして追跡する | Must |
| BA-INFRA-06 | Runtime登録、heartbeat、Tool Catalog、Connection Testまで確認して接続完了とする | Must |
| BA-INFRA-07 | 生PDFや業務DBをControl Planeへ複製しない | Must |
| BA-INFRA-08 | 生データを外部モデルへ送るか、Runtime内で構造化して要約だけ送るかをデータフローとして固定する | Must |

### 6.7 Workflow生成（BA-WF）

既存の直列 + Approvalに加えて、Builder Agent MVPでは以下を追加する。

- `agent`: Agent Deploymentを実行
- `tool`: 決定的なToolを直接実行
- `condition`: 型付き値で分岐
- `approval`: 人間承認
- `transform`: JSON Schema間の決定的変換
- `wait`: 外部Job / Webhook待ち
- `compensate`: 失敗時の補償処理

| ID | 要件 | 優先度 |
|---|---|---|
| BA-WF-01 | DAGまたは明示的な分岐を定義し、循環を禁止する | Must |
| BA-WF-02 | ステップの入出力をJSON Schemaで検証する | Must |
| BA-WF-03 | 金額閾値、存在有無、ステータスなど決定的条件はLLMではなく`condition`で評価する | Must |
| BA-WF-04 | ステップごとにRuntime、Connection、Timeout、Retry、Idempotencyを固定する | Must |
| BA-WF-05 | `waiting_approval`、`waiting_input`、`waiting_external`から再開できる | Must |
| BA-WF-06 | 部分失敗時に、再実行可能なステップと再実行禁止のステップを区別する | Must |
| BA-WF-07 | Workflow DefinitionもImmutable Buildへ固定する | Must |

### 6.8 検証・自動デバッグ（BA-TEST）

| ID | 要件 | 優先度 |
|---|---|---|
| BA-TEST-01 | Schema、型、Lint、Unit、Contract、Integration、Security Testを段階実行する | Must |
| BA-TEST-02 | 外部書き込み前にMock / Sandbox / Dry Runを優先する | Must |
| BA-TEST-03 | 読取Toolは実接続Smoke Testを実施する | Must |
| BA-TEST-04 | 書込Toolは明示承認されたテスト対象だけで実行し、作成物を確認・後片付けする | Must |
| BA-TEST-05 | Browser FlowはSnapshotとScreenshotの両方で結果を確認する | Must |
| BA-TEST-06 | 正常系、入力不正、認証切れ、権限不足、Timeout、重複実行、Provider 4xx/5xxを検証する | Must |
| BA-TEST-07 | Tenant分離、Secret非露出、SSRF、Prompt Injection、Tool権限逸脱を検証する | Must |
| BA-TEST-08 | 失敗を`requirement / auth / schema / code / network / provider / policy / runtime / unknown`へ分類する | Must |
| BA-TEST-09 | 修正可能な失敗は、差分生成 → テスト → Previewを上限回数内で自動反復する | Must |
| BA-TEST-10 | 同一失敗が規定回数続いた場合は、証拠と試行内容を残して人へ引き継ぐ | Must |
| BA-TEST-11 | Preview Runの実出力と期待値をEval Caseで判定する | Must |
| BA-TEST-12 | 「プロセス開始」「OAuth画面表示」「HTTP 200」だけを成功証拠にしない | Must |

### 6.9 Build・Preview・Production（BA-REL）

| ID | 要件 | 優先度 |
|---|---|---|
| BA-REL-01 | 生成したAgent、Workflow、Tool Version、Policy、Runtime Profileを1つのBuilder Releaseへ関連付ける | Must |
| BA-REL-02 | Preview Buildには実装commit、Tool Version、Workflow Version、Config Hashを固定する | Must |
| BA-REL-03 | Preview成功後、同一BuildをProductionへ昇格する | Must |
| BA-REL-04 | Production昇格前にProduction Connection / Variables / Runtime readinessを再検証する | Must |
| BA-REL-05 | Production変更は差分、外部作用、データ送信先、費用、Rollbackを表示してAdmin承認を受ける | Must |
| BA-REL-06 | Deployment後にHealth Checkと限定Production Runを実施する | Must |
| BA-REL-07 | 失敗時は直前の成功Buildへ自動または承認付きでRollbackする | Must |
| BA-REL-08 | 生成コードのPR作成を基本とし、mainへの直接pushを初期値で禁止する | Must |

### 6.10 人間専用操作（BA-HUMAN）

Human Actionは自由文ではなく、型付きタスクとして扱う。

```yaml
type: oauth_consent | enter_secret | provider_app_registration | human_login |
      aws_admin_action | business_rule_confirmation | production_approval
title: Qiita OAuthアプリを登録
reason: 記事公開用Connectionの作成に必要
fields: []
instructions: []
resume_condition: connector.oauth_app.configured == true
expires_at: null
```

| ID | 要件 | 優先度 |
|---|---|---|
| BA-HUMAN-01 | 人間操作には理由、手順、対象画面、必要権限、完了条件を表示する | Must |
| BA-HUMAN-02 | Secret値はチャットへ貼らせず、専用入力へ誘導する | Must |
| BA-HUMAN-03 | 完了条件をシステムが検知し、Builder Runを自動再開する | Must |
| BA-HUMAN-04 | Owner / Admin / AWS Adminなど、実行可能な役割へ割り当てる | Must |
| BA-HUMAN-05 | MFA、CAPTCHA、規約同意を回避・代行しない | Must |
| BA-HUMAN-06 | 期限切れや拒否を検知し、代替方法か安全な中止を提示する | Must |

### 6.11 セキュリティ（BA-SEC）

| ID | 要件 | 優先度 |
|---|---|---|
| BA-SEC-01 | Builder Workspaceを組織・Builder Runごとに隔離し、終了後に破棄する | Must |
| BA-SEC-02 | Builder AgentへProduction DBの直接資格情報を渡さない | Must |
| BA-SEC-03 | SecretはSecret Store参照名だけを扱い、モデル、Git、Build、ログへ値を含めない | Must |
| BA-SEC-04 | 生成コードの依存関係をAllowlist、lockfile、脆弱性検査、SBOMで管理する | Must |
| BA-SEC-05 | 外向き通信を調査対象と公式Package Registryへ制限する | Must |
| BA-SEC-06 | BrowserはRunごとの隔離、FQDN allowlist、Private IP拒否を継承する | Must |
| BA-SEC-07 | 生成ToolはAgent StudioとTool Gatewayの二重許可を通る | Must |
| BA-SEC-08 | Builder Agent自身がPolicy、Approval、Auditを無効化できない | Must |
| BA-SEC-09 | Prompt Injectionを外部仕様・Web・ファイルからの非信頼入力として扱う | Must |
| BA-SEC-10 | 送信データ、保存先、保持期間、モデルへ渡る情報をBuild前に表示する | Must |
| BA-SEC-11 | 高リスク判断は根拠データ、ルール版、人間承認者を記録する | Must |

### 6.12 証跡・説明可能性（BA-AUD）

| ID | 要件 | 優先度 |
|---|---|---|
| BA-AUD-01 | 依頼文、解釈、Capability Graph、調査根拠、生成差分、テスト、承認、Deploymentを相関IDで追跡する | Must |
| BA-AUD-02 | モデルの自由文だけでなく、決定的な状態・ハッシュ・バージョンを保存する | Must |
| BA-AUD-03 | Builder Agentが行った外部操作をTool Call単位で記録する | Must |
| BA-AUD-04 | 判断結果に、利用データ、ルール、例外、Confidence、Human Overrideを付ける | Must |
| BA-AUD-05 | 監査ログは追記のみとし、組織境界をRLSと複合外部キーで守る | Must |
| BA-AUD-06 | Secretと生の銀行・本人確認データをControl Plane監査ログへ含めない | Must |

### 6.13 利用画面（BA-UX）

Builder Project画面は次のタブを持つ。

```text
Overview | Plan | Setup | Changes | Tests | Preview | Releases | Audit
```

| 画面 | 表示内容 |
|---|---|
| Overview | 依頼、現在状態、完成条件、次の自動処理、人間の待ち |
| Plan | 業務フロー、Capability Graph、実行場所、外部送信 |
| Setup | OAuth、Secret、Human Login、AWS管理者操作 |
| Changes | 生成Connector、Tool、コード、Terraform、Migrationの差分 |
| Tests | 自動テスト、実接続、Browser証拠、Eval結果 |
| Preview | 実際のPreview AgentとRun |
| Releases | Build、Production Promote、Rollback |
| Audit | 誰が・いつ・何を変更・承認・実行したか |

UIでは、MCP、Function Calling、Vault、ECS Taskなどの内部用語を通常利用者へ直接見せず、「連携サービス」「接続済みアカウント」「実行場所」「準備が必要な操作」と表現する。

---

## 7. データモデル案

| エンティティ | 主な項目 |
|---|---|
| `builder_projects` | organization_id、request、status、target、created_by |
| `builder_runs` | project_id、attempt、status、budget、started_at、finished_at |
| `builder_steps` | kind、status、input_hash、output_ref、error_class、attempts |
| `capability_plans` | requirements、graph、risks、execution_locations、version |
| `capability_gaps` | requirement、gap_type、resolution_strategy、status |
| `human_actions` | type、assignee_role、instructions、resume_condition、status |
| `change_sets` | repository、branch、base_sha、head_sha、diff_summary、risk |
| `generated_components` | connector_id、tool_ids、workflow_id、artifact refs |
| `validation_runs` | suite、environment、status、evidence refs、failure class |
| `builder_releases` | build ids、workflow version、commit sha、config hash、status |

すべてのエンティティに`organization_id`を持たせ、RLSと組織IDを含む複合外部キーを適用する。

---

## 8. ファクタリングAgent受け入れシナリオ

既存の`runtime/demo-factoring-api`を、Builder Agentの複雑業務E2Eに利用する。実データ、実在個人、実際の反社判定は使わない。

### 8.1 利用者の依頼

```text
ファクタリング申込を審査するAgentを作ってください。
型付きの申込情報を受け取り、Kintone相当の社内DBで過去問い合わせを確認します。
過去問い合わせがあり希望額が100万円未満なら承認候補にします。
新規なら外部のコンプライアンス情報と法人情報を確認します。
顧客AWS内のファイルサーバーから通帳PDFを取得し、売掛先から毎月継続して
整合する入金があるか調べます。最終結果は担当者が承認し、社内DBへ記録します。
生PDFは顧客AWSの外へ出さないでください。
```

### 8.2 期待する生成物

1. 型付き申込Input Schema
2. 社内DB / Kintone Connector
3. 過去問い合わせ検索Tool
4. コンプライアンス検索Connector（E2EではMock）
5. 法人確認Browser FlowまたはAPI Tool
6. ファイルサーバーConnector
7. Runtime内OCR・取引抽出Tool
8. 入金整合性を計算する決定的Tool
9. 条件分岐を持つWorkflow
10. 最終承認Step
11. 審査結果書き戻しTool
12. Self-hosted Runtime設定
13. Eval Case、テスト、Preview Build、Rollback情報

### 8.3 型付き入力例

```json
{
  "application_id": "APP-2026-000123",
  "applicant": {
    "corporate_number": "1234567890123",
    "company_name": "株式会社サンプル"
  },
  "counterparty": {
    "corporate_number": "9876543210987",
    "company_name": "株式会社取引先"
  },
  "requested_amount": 800000,
  "invoice_amount": 1200000,
  "invoice_due_date": "2026-10-31",
  "bank_statement_file_ids": ["statement-2026-04-09"]
}
```

### 8.4 データ境界

| データ | 保存・処理場所 | Control Plane / モデルへ送る内容 |
|---|---|---|
| 申込の識別情報 | 顧客DB / Kintone | 実行に必要な最小項目 |
| 通帳PDF | 顧客AWSのFile Server / S3 | 原則送らない |
| OCR結果 | 顧客Runtime | 月別集計、名義一致結果、Confidenceだけ |
| Connection Secret | 顧客AWS Secrets Manager | 参照名のみ |
| 審査理由 | 顧客DB + Agent Studio Audit要約 | 生取引明細を除く理由コード |

### 8.5 判断の分離

次をLLMだけで決めない。

- 100万円未満か
- 過去問い合わせがあるか
- 月ごとに入金が存在するか
- 金額差が許容範囲か
- 同じ請求書番号があるか
- 最終的に社内DBへ承認を書き込むか

LLMは、表記揺れ候補、文書要約、不足資料説明、担当者向け説明文に利用する。数値・存在判定・分岐は型付きToolとルールエンジンで行う。

### 8.6 E2E完成条件

| # | 完成条件 |
|---|---|
| 1 | 自然言語依頼からCapability Graphと不足能力が生成される |
| 2 | 既存`demo-factoring-api`のToolを再利用し、無関係なToolを選ばない |
| 3 | 未登録のMockコンプライアンスConnectorを自動生成できる |
| 4 | Self-hosted Runtimeで社内APIを呼び、Control Planeから直接呼ばない |
| 5 | 条件分岐が入力値とTool結果どおりに再現可能に動く |
| 6 | PDF fixtureをRuntime内で解析し、生PDFをモデル・Control Planeへ送らない |
| 7 | 読取後、書き戻し前に人間承認で停止する |
| 8 | 承認後に1回だけ審査結果を書き戻す |
| 9 | 同じRunの再試行で重複結果を作らない |
| 10 | 可・否・保留のEval Caseが期待どおりになる |
| 11 | Secret、PDF本文、口座番号がBuild・ログ・Gitに含まれない |
| 12 | Preview成功後に同一BuildをProductionへ昇格し、Rollbackできる |

---

## 9. 自律実行の境界

### 9.1 自動で行ってよいこと

- 読取専用の仕様・Schema・Tool Catalog調査
- 組織内Connector / Tool /コードの検索
- 隔離branchでのコード・テスト・設定生成
- Mock / Sandboxへのデプロイ
- 読取専用Connection Test
- Preview環境でのテスト
- 承認済みテスト対象への限定書き込み
- 失敗原因の分類と安全な範囲の修正

### 9.2 必ず承認が必要なこと

- Production Infrastructureの変更
- 新規外部送信先の追加
- Production Secretの利用
- 実顧客データへの書き込み・削除・送信
- 金額、信用、契約、アカウント状態を変える操作
- mainへのmerge、Production Promote、Rollback
- ライセンス・利用規約・費用が発生する外部サービス契約

### 9.3 禁止事項

- CAPTCHAやMFAの回避
- 利用者の代わりに規約へ同意
- Secretをチャット・Prompt・Git・ログへ出す
- 外部Webの文章をBuilder Agentへの命令として実行
- 未確認のAPI仕様からProduction書き込みToolを生成
- テストなしのProduction反映
- PolicyやAuditを無効化して処理を継続
- 高リスク判断を根拠なしで自動確定

---

## 10. 非機能要件（BA-NFR）

| ID | 要件 | 目標 |
|---|---|---|
| BA-NFR-01 | 再開性 | API / Worker再起動後も最後の成功Stepから再開 |
| BA-NFR-02 | 冪等性 | 同一Builder Stepの再試行で重複外部作用を作らない |
| BA-NFR-03 | テナント分離 | 他組織のProject、Workspace、Secret、Artifactへアクセス不可 |
| BA-NFR-04 | 予算 | Runごとに時間、Token、外部API費用、再試行回数の上限を設定 |
| BA-NFR-05 | 可観測性 | Step、Tool、Code Change、Test、Deploymentを1つの相関IDで追跡 |
| BA-NFR-06 | 復旧 | Builder中断、Provider障害、Runtime offlineから安全に再開 |
| BA-NFR-07 | 性能 | 宣言的ConnectorはHuman Gateを除き30分以内にPreview到達を目標 |
| BA-NFR-08 | 保持 | Workspaceは完了後破棄し、必要なDiff・Test Evidenceだけ保管 |
| BA-NFR-09 | 互換性 | 既存Agent、Tool、Connector、Build、Deploymentを壊さない |

---

## 11. 実装フェーズ

### Phase 0: Builder Project基盤

- Builder Project / Run / Step / Human Actionの状態モデル
- 長時間処理の停止・再開
- Capability GraphとGap分類
- 既存Registryの再利用
- Plan / Setup / Tests画面

完了条件: 未登録能力を無関係なToolへ誤接続せず、実装計画とHuman Gateを表示できる。

### Phase 1: 宣言的Connector Builder

- OpenAPI / MCP Discovery
- HTTP ConnectorとTool Schema生成
- Risk分類、Connection要件、Secret入力
- Contract Test、読取Smoke Test
- Preview Build自動作成

完了条件: 新しい公開API Connectorを自然言語 + API仕様から生成し、Preview Runまで完了する。

### Phase 2: Provider Setup / Human Login

- OAuth App Setup Action
- Dynamic Client Registration
- Human Login Browser Session
- Browser Profile暗号化保存
- Scope不足、期限切れ、再認証

完了条件: 技術者の介助なしに、利用者自身の認証操作だけで接続完了し、自動再開する。

### Phase 3: Code Agent

- Isolated Git Workspace / branch
- Adapter / MCP / Backend生成
- Unit / Integration / Security Test
- PR、CI、Preview環境
- 自動デバッグループ

完了条件: 宣言的設定で対応できないAdapterを実装し、CIとPreview E2Eを通せる。

### Phase 4: Workflow v2

- Condition / Tool / Transform / Wait / Compensate
- JSON SchemaによるStep入出力
- 分岐、再試行、補償、再開
- Workflow Build / Promote / Rollback

完了条件: ファクタリング受け入れシナリオの条件分岐と承認が決定的に動く。

### Phase 5: Self-hosted Provisioning

- Runtime Config生成
- Terraform Plan生成と承認Apply
- Network / DNS / Secret Setup Actions
- Runtime登録、Tool Catalog、Health Check
- Runtime内Document Processing

完了条件: 顧客AWS内のDB・File Server・OCR Toolを使うPreview Runが完了する。

### Phase 6: Production運用

- Production Release Review
- 限定Production Run
- Provider Health、Drift検知
- 自動Rollback
- 定期Eval、Connector仕様変更追跡

完了条件: Provider仕様変更や認証切れを検知し、安全に修復または停止できる。

---

## 12. MVPの範囲

最初のMVPは、すべてのSaaSや任意コード生成を同時に扱わない。

### MVPに含める

- Builder Projectと再開可能な状態管理
- 自然言語からCapability Graph
- OpenAPI / MCPから宣言的Connector生成
- OAuth / API TokenのSetup Action
- Preview用の自動テストとデバッグ
- 条件分岐Workflow
- Self-hosted Runtime Config生成
- 既存ファクタリングデモでのE2E

### MVPに含めない

- 任意言語・任意フレームワークの完全自律開発
- 無承認のProduction Infrastructure変更
- 利用規約への自動同意
- CAPTCHA / MFAの自動突破
- 法務・信用判断の完全自動確定
- 未知のデスクトップアプリをComputer Visionだけで安定操作
- Connector Marketplaceの公開審査・課金

---

## 13. 決定事項

| ID | 決定 |
|---|---|
| BA-D-01 | Builder Agentと業務Agentを別の権限・Runtimeとして扱う |
| BA-D-02 | 宣言的ConnectorをCustom Codeより優先する |
| BA-D-03 | APIをBrowser Automationより優先する |
| BA-D-04 | Secretはモデルへ渡さず、Secret Storeへの書き込み専用経路を使う |
| BA-D-05 | Builder Agentは隔離branchとPreviewまでは自律、Productionは承認制 |
| BA-D-06 | 金額・存在・閾値・分岐は決定的なWorkflow / Rule Engineで実行する |
| BA-D-07 | 生の機微データを外部モデルへ送るかをデータフローとして明示・固定する |
| BA-D-08 | 完成判定は保存やBuild成功ではなく、実Preview E2Eと証跡で行う |
| BA-D-09 | Builder Runは中断可能・再開可能・冪等にする |
| BA-D-10 | ファクタリングデモを複雑業務の主要受け入れテストにする |

---

## 14. 実装前に決める未決事項

| ID | 論点 | 選択肢 | 推奨 |
|---|---|---|---|
| BA-Q-01 | Code Agentの実行基盤 | OpenAI self-hosted / Codex task / 独自sandbox | 既存self-hostedを基礎に、Builder専用Workspaceを追加 |
| BA-Q-02 | 生成コードの反映 | PRのみ / 承認後に既定branchへ自動merge | Agent Studio上の管理者承認後に自動merge |
| BA-Q-03 | 公式資料の取得 | Internet全体 / Domain allowlist | 公式Domain allowlist + 利用者提供資料 |
| BA-Q-04 | Builderのモデル | 単一モデル / PlannerとCoderを分離 | Planner、Coder、Verifierを役割分離 |
| BA-Q-05 | Human Login Profileの保存 | 顧客AWS / Agent Studio | Self-hostedは顧客AWS、Hostedは組織別暗号化Store |
| BA-Q-06 | Terraform apply | Builder Agentが実行 / CIが実行 | Builder AgentはPlan、承認後CIがApply |
| BA-Q-07 | 高リスク業務の承認 | 組織設定 / 固定必須 | 金融・法務・人事は固定必須 + 組織で追加可能 |
| BA-Q-08 | Builder Projectのコード所有 | Agent Studio共通repo / 顧客repo | 共通ConnectorはAgent Studio、顧客固有Adapterは顧客repoに限定 |

---

## 15. 最終受け入れ条件

Builder Agent MVPは、次の一連の操作を技術者の手作業なしで完了できたとき受け入れる。

1. 利用者がファクタリング自動化の依頼とInput Schemaを入力する
2. Builder Agentが既存ファクタリングAPI、Browser、Runtime能力を発見する
3. 不足するMockコンプライアンスConnectorを生成する
4. 人間に必要なSecret / Login / AWS操作だけをSetupへ表示する
5. 操作完了を検知して自動再開する
6. Workflow、Agent、Tool、Policy、Runtime Configを生成する
7. 自動テスト、Security Test、Preview Runを実行する
8. 失敗をログ・API・Browser証拠から診断し、修正後に再実行する
9. 可・否・保留のEval Caseを通す
10. 同一BuildをProduction候補として提示する
11. Admin承認後にProductionへ昇格する
12. 限定Production Run、Health、Audit、Rollbackを確認する

この一連の途中で人間操作を待つことは許容するが、操作完了後に技術者がコードや設定を手で直すことを前提にしない。
