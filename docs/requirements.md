# Agent Studio 要件定義書（ドラフト v0.1）

| 項目 | 内容 |
|---|---|
| 作成日 | 2026-09-19 |
| ステータス | ドラフト（§16 の未決事項あり） |
| 入力 | 提示されたアーキテクチャ案（Agent Studio = Control Plane / Company Runtime = Execution Plane） |
| 前提確認 | OpenAI Agents API の公式ドキュメント（2026-09-19 時点）で主要な前提を確認済み（§4） |

---

## 0. このドキュメントについて

- 元のアーキテクチャ案を要件として整理し、ID付きで管理できる形にしたもの。
- 元案にない要素は **【追加提案】**、元案を変える要素は **【修正提案】** と印をつけている。
- 要件IDの接頭辞: `ORG` 組織・認証 / `AGT` Agent / `CMP` Compiler / `WF` Workflow / `TOOL` Tool Registry / `CONN` Connections / `POL` Policy / `ENV` 実行環境 / `DEP` Deployment / `RUN` 実行 / `RTM` Runtime Manager / `CRT` Company Runtime / `PRV` Provisioning / `EVAL` / `AUD` 監査 / `BILL` 課金 / `SEC` セキュリティ / `NFR` 非機能

### 0.1 元案からの主な追加・修正（要約）

1. **Tool Gateway の追加【追加提案】** — OpenAI の公式ドキュメントに「エージェントが生成したコードは環境キーを読める」とある。つまり Executor（`codex exec-server`）のコンテナ内にあるものは、すべてモデルから読める前提で設計する必要がある。SAP などの認証情報は Executor に置かず、Runtime 内の別サービス（Tool Gateway）に持たせ、ツール呼び出しの許可判定・承認・監査もそこで強制する。
2. **企業ごとに OpenAI Project を分ける【追加提案】** — 環境キーは「セッション所有者と同じ組織・プロジェクト」に属する必要がある。1つのプロジェクトを全社で共有すると、A社 Runtime の環境キーで B社セッションの環境に接続できてしまう可能性がある（PoC で確認）。企業ごとにプロジェクトを分ければ、この経路を構造的に塞げる。
3. **Self-hosted でもデータは OpenAI に送られる（顧客への説明が必要）** — Self-hosted で守れるのは「認証情報」「実行場所」「社内ネットワークへの到達経路」。ツールの結果やコマンドの出力はハーネス（OpenAI 側）に送られる。さらに Agents API のデータ所在地は **米国のみ** で、**ZDR（Zero Data Retention）には非対応**（Self-hosted でも同じ）。
4. **RLS・監査ログを Phase 1 に前倒し【修正提案】** — 後から入れるとデータ移行とテストの全面的な見直しが必要になるため。
5. **Phase 0（技術検証）の追加【追加提案】** — ドキュメントで確認できない点（環境キーを API で発行できるか、Executor の再接続、承認の仕組みなど）を先に PoC で潰す。
6. **Agent Manifest の修正【修正提案】** — 実行時の入力（「400円下げる」）は Manifest に含めない。実行環境は `runtime_id` を直接書かず、Environment（staging / production）を参照する。
7. **Runtime 認証方式の具体化** — 「AWS IAM 署名」は、署名済みの `sts:GetCallerIdentity` リクエストを検証する方式（HashiCorp Vault の AWS IAM 認証と同じ方式）で実現する。API Gateway を前提にせず、Hono の API でも検証できる。

---

## 1. 目的とゴール

### 1.1 目的
企業ごとに安全に分離された環境で、業務用の AI Agent を設計・デプロイ・実行・監査できる SaaS「Agent Studio」を AWS 上に構築する。

### 1.2 ゴール
- 日本語で業務を説明すると Agent が作れ、そのまま実行できる。
- 実行場所を「OpenAI の環境」「Agent Studio が管理する企業専用の AWS」「顧客自身の AWS」から選べる。
- 企業の業務システム（SAP、社内 DB、社内 API、ブラウザ操作）の認証情報をその企業の AWS の外に出さずに Agent から操作できる。
- 企業をまたいだデータ・権限・実行の混在が、アプリのバグがあっても起きない（多重防御）。
- 企業数が 100 社、1,000 社に増えても、同じ Terraform module を量産する形で拡張できる。

### 1.3 受け入れシナリオ（MVP の完成判定）
1. Sample A社の管理者がログインすると、A社のデータだけが表示される。
2. 日本語で「指定した商品の価格を変更する Agent」を作ると、Manifest が生成される。
3. その Agent を Self-hosted（A社 production）にデプロイする。
4. 「商品Xの価格を400円下げて」と実行すると、A社 AWS 内でセッション専用の Worker が起動し、Tool Gateway 経由で社内 API（モック）の価格が更新される。
5. 「600円下げて」と実行すると承認待ちになり、承認者が承認した後にだけ実行される。
6. 完了後に Worker が破棄され、すべての操作が監査ログに記録されている。
7. B社のユーザーと B社の Runtime は、上記のどのデータにも操作にもアクセスできない。

---

## 2. スコープ

### 2.1 対象
- Agent Studio 本体（Control Plane）: Web UI、API、Agent 定義、Workflow、Tool Registry、Connections、Policy、Deployment、Runs、監査、Runtime 管理
- Company Runtime（Execution Plane）: Runtime Controller、Session Worker、Tool Gateway、MCP Servers、Browser Worker
- IaC: Control Plane 用と、テナント Runtime 用の Terraform module
- Runtime の提供形態 2 種（Agent Studio 管理の AWS / 顧客所有の AWS）

### 2.2 対象外（当面）
- OpenAI 以外の Agent 実行基盤（Claude など）への対応。ただし Compiler の出力先は差し替えられる構造にしておく。
- オンプレミスや AWS 以外のクラウドでの Runtime 実行
- モバイルアプリ

---

## 3. 用語

| 用語 | 定義 |
|---|---|
| Control Plane | Agent Studio 本体。設計・管理・実行の指示・記録を担う。`agent-studio` の AWS アカウント |
| Execution Plane | 企業ごとの実行環境（Company Runtime）。企業専用の AWS アカウント |
| Organization | テナント（契約企業）。不変の UUID で識別する |
| Runtime | ある企業の、ある環境（staging / production）の Execution Plane。AWS アカウント ID と IAM ロールに紐づく |
| Runtime Instance | Runtime Controller のプロセス（バージョン・ハートビート単位） |
| Runtime Profile / Environment | Agent の実行場所の設定。OpenAI Managed / Agent Studio Managed AWS / My AWS Account |
| Session | OpenAI Agents API のセッション。Self-hosted では、セッションごとに固有の environment ID と専用 Executor を持つ |
| Run | Agent Studio 上の 1 回の実行。1 つ以上の Session を含む |
| Executor | `codex exec-server`。Self-hosted 環境でシェル実行・ファイル操作・環境内 MCP の利用を担う |
| Session Worker | Executor を動かす、セッション専用の ECS Fargate タスク |
| Tool Gateway 【追加提案】 | Runtime 内で業務ツールへの呼び出しを仲介し、認可・ポリシー・承認・監査・認証情報の注入を担うサービス |
| Agent Manifest | Agent 定義の正本（YAML/JSON） |
| Deployment | Agent のバージョンと実行環境の組み合わせ |
| Hybrid Deployment | 実行場所の異なるツールや Agent を組み合わせた構成。Agent Studio 上の概念で、OpenAI API に `hybrid` という型はない |
| Bootstrap Token | Runtime の初回登録に一度だけ使うトークン |
| アプリキー | Agent Studio が保持する OpenAI API キー（Agent・Session の作成用） |
| 環境キー | Executor に渡す、環境への接続権限だけを持つ制限付き OpenAI API キー（`CODEX_API_KEY`） |

---

## 4. 前提: OpenAI Agents API の仕様（2026-09-19 時点で確認）

### 4.1 確認できた事項

| # | 事項 | 内容 |
|---|---|---|
| 1 | 環境タイプ | `environment.type` は `none` / `openai_hosted` / `self_hosted` の 3 種類。`hybrid` はない |
| 2 | Self-hosted の分担 | モデルとツールループ（ハーネス）は OpenAI 側。顧客環境では `codex exec-server` がシェル実行・ファイル読み書き・ローカル MCP の利用を担う |
| 3 | セッション作成 | `POST /v1/agents/sessions`（SDK: `client.beta.agents.sessions.create()`）。レスポンスで `session.id`、`session.environment.id`、`session.environment.remote_url` が返る |
| 4 | Executor の起動 | `codex exec-server --remote "<remote_url>" --environment-id "<environment.id>"`。環境変数 `CODEX_API_KEY` に環境キーを設定する |
| 5 | 通信 | Executor から `https://api.openai.com` と `wss://codex-cloud-environments.chatgpt.com` へのアウトバウンド通信のみ。切断時は自動で再接続する |
| 6 | Executor の単位 | セッションごとに固有の environment ID と専用の Executor が必要。コンテナイメージと `workspace_directory` は再利用できる |
| 7 | API キーの分離 | アプリキー（`api.agents.read` / `api.agents.write` / `api.responses.write`、必要に応じて `api.vaults.*`）はサンドボックスの外に置く。Executor には、環境接続以外の権限をすべて None にした環境キーだけを渡す |
| 8 | 環境キーの所属 | 環境キーは、セッションを所有する組織・プロジェクト・ユーザー（またはサービスアカウント）と同じ所属である必要がある。発行はダッシュボードの Agents タブで行う（API で発行できるかは未確認） |
| 9 | 環境キーは読める | 公式に「エージェントが生成したコードは環境キーを読める（ただし環境の接続にしか使えない）」とある |
| 10 | 接続状態イベント | `agent.session.environment.pending` / `connected` / `failed` |
| 11 | MCP の接続元 | `connection_origin: "service"`（OpenAI から接続。公開された場所にある必要がある。vault の認証情報を使える）と、`"environment"`（環境内から接続。プライベートネットワーク上のサーバーに使える。HTTP または stdio。**vault は使えない**。認証は `transport.authorization` / `transport.headers`、stdio では `transport.env_vars`） |
| 12 | Function tool | アプリケーションサーバー（= Agent Studio）が呼び出しを受けて実行し、結果を返す。セッションは `requires_action` になり、`agent.session.requires_action` イベントまたは webhook で通知される |
| 13 | ターン | 完了・失敗・中止は `agent.session.turn.completed` / `failed` / `cancelled`。中止は `agent.session.input.cancel` を送る。セッション削除は `DELETE /v1/agents/sessions/{id}` |
| 14 | OpenAI-hosted | 作業ディレクトリは `/workspace`。`packages` / `setup_commands` / `files` / `env` / `skills` / `plugins` / `environment_template_id` を指定できる。ネットワークは `enabled` / `disabled` / `restricted`（`allowed_domains` にホスト名を 1〜100 件）。操作がないまま 1 時間経つと削除されることがある（変更不可）。`/workspace/outputs` のファイルは成果物として残る |
| 15 | データ所在地・ZDR | Agents API のデータレジデンシーは **米国のみ**。**ZDR 非対応**（Self-hosted でも同じ） |
| 16 | ベータ | `OpenAI-Beta: agents=v1` ヘッダが必要。SDK は `client.beta.agents.*` |

### 4.2 設計への影響

- **A. Self-hosted は「データを OpenAI に渡さない」仕組みではない。** ツールの結果、ファイルの内容、コマンドの出力はハーネスに送られる。Self-hosted で守れるのは、認証情報の保管場所・実行場所・社内ネットワークへの到達経路。これを顧客への説明と契約（データ処理の範囲、米国での処理、ZDR 不可）に反映する必要がある。
- **B. Executor は信頼しない領域として扱う。** Executor のコンテナ内の環境変数・ファイル・IAM 権限はすべてモデルから読める前提にする。そのため、業務システムの認証情報や AWS の権限を Session Worker に置かない。→ Tool Gateway（§5.3）
- **C. プライベートな MCP は `connection_origin: "environment"` で接続する。** vault が使えないので、Agent の設定に認証情報を書かないように、認証は Tool Gateway 側で行う。
- **D. 環境キーはプロジェクト単位なので、企業ごとに OpenAI Project を分ける。**（SEC-11）
- **E. ツールは実行場所で分類する。** Agent Studio 側で実行するもの（通知、承認依頼など）は function tool、公開 SaaS は service MCP、社内システムは environment MCP（Tool Gateway 経由）。
- **F. Hybrid は 2 段階で実現できる。** (1) 1 つの Self-hosted セッション内で service MCP（公開ツール）と environment MCP（社内ツール）を混在させる。(2) Workflow で、実行環境の異なる複数セッションを組み合わせる。

### 4.3 PoC（Phase 0）で確認すること

| # | 確認事項 | 影響する設計 |
|---|---|---|
| P-1 | ECS Fargate 上で `codex exec-server` が動作・接続できるか。起動から `connected` までの時間 | Session Worker、性能要件 |
| P-2 | 環境キーとプロジェクト・サービスアカウントを API（Admin API）で作れるか | 自動プロビジョニング（Phase 6）。作れない場合は手作業が残る |
| P-3 | 同じプロジェクト内なら、ある環境キーで別セッションの環境に接続できてしまうか | SEC-11 の必要度 |
| P-4 | Executor が停止した後、同じ environment ID で新しい Executor が再接続できるか | ワークスペースの永続化、アイドル時の停止方針 |
| P-5 | MCP・シェル実行に対する承認（human-in-the-loop）の仕組みが API にあるか。`required_actions` の種類 | POL（承認フロー）の実装場所 |
| P-6 | Self-hosted セッションのアイドルタイムアウトと最大寿命 | Session Worker の寿命 |
| P-7 | multi-agent でサブエージェントごとに別の environment を持てるか | Hybrid・Workflow の設計 |
| P-8 | webhook の署名検証と再送の仕様 | RUN-04 |
| P-9 | Self-hosted で `skills` / `plugins` をセッション設定から渡せるか、イメージに含める必要があるか | Session Worker のイメージ設計 |
| P-10 | セッション作成時の `input` を、Executor の接続前に送ってよいか | 実行フローの順序 |

---

## 5. 全体アーキテクチャ

### 5.1 Control Plane と Execution Plane

```text
                     Agent Studio（Control Plane）
                     agent-studio-prod AWS アカウント
┌──────────────────────────────────────────────────────────┐
│ CloudFront + WAF                                          │
│   ├ Web（Next.js）                                         │
│   ├ API（Hono）                                            │
│   └ Runtime API（Runtime Controller 専用エンドポイント）    │
│                                                           │
│ Agent Compiler / Workflow Engine / Tool Registry          │
│ Connector Manager / Policy Engine / Runtime Manager       │
│ Deployment Manager / Run Orchestrator / Eval / Audit      │
│                                                           │
│ RDS PostgreSQL（RLS）/ Redis / S3 / SQS / EventBridge      │
│ Secrets Manager（企業別の OpenAI アプリキー）/ KMS          │
└───────────────┬───────────────────────────▲──────────────┘
                │ セッション作成・入力送信   │ ジョブ取得・状態報告
                ▼                           │ （Runtime からのアウトバウンドのみ）
        OpenAI Agents API                   │
        （企業ごとの Project）              │
          │           ▲                     │
          │           │ WSS（アウトバウンド）│
          ▼           │                     │
   OpenAI-hosted   ┌──┴─────────────────────┴───────────┐
   サンドボックス   │ Company Runtime（Execution Plane）  │
                   │ sample-a-company-prod AWS アカウント │
                   └────────────────────────────────────┘
```

### 5.2 責務の分担

| 責務 | Agent Studio（Control Plane） | Company Runtime（Execution Plane） |
|---|---|---|
| ユーザー・組織・権限 | ○ | − |
| Agent・Workflow・Tool・Policy の定義 | ○（正本） | 実行に必要な分だけ受け取る |
| OpenAI アプリキー | ○（企業ごと） | ×（持たない） |
| OpenAI 環境キー | 発行・ローテーションを管理 | ○（Secrets Manager に保管） |
| 業務システムの認証情報 | ×（参照名 `secret_ref` のみ） | ○（Secrets Manager） |
| OpenAI セッションの作成 | ○ | − |
| Executor の実行 | − | ○（Session Worker） |
| 業務システムへのアクセス | − | ○（Tool Gateway 経由のみ） |
| ポリシーの強制 | studio_function のツール | runtime_mcp のツール（Tool Gateway） |
| 監査ログ | ○（全体） | ○（Runtime 内の操作。要約を Agent Studio に送る） |

### 5.3 Company Runtime の内部構成【追加提案: Tool Gateway】

```text
Company Runtime（企業ごとの AWS アカウント / VPC、Private Subnet のみ）
┌───────────────────────────────────────────────────────────────┐
│ Runtime Controller（ECS Service、常駐）                          │
│   ├ Agent Studio からジョブを取得（アウトバウンド HTTPS）          │
│   ├ Session Worker の起動・停止（ecs:RunTask / StopTask）        │
│   ├ セッション用トークンの発行、Tool Gateway へのセッション登録   │
│   └ ハートビート・状態報告                                        │
│                                                                 │
│ Session Worker（Fargate Task、セッションごと・使い捨て）          │
│   └ codex exec-server        ← 信頼しない領域                    │
│       ・業務システムの認証情報を持たない（環境キーだけ）           │
│       ・タスクロールに AWS の権限を持たせない                      │
│       ・通信先は OpenAI と Tool Gateway だけ                       │
│             │ MCP（HTTP、VPC 内、セッション用トークン）            │
│             ▼                                                    │
│ Tool Gateway（ECS Service、常駐）  ← 信頼する領域                 │
│   ├ セッション用トークンの検証と、許可されたツールの判定            │
│   ├ ポリシー判定・承認待ち（Controller 経由で Agent Studio に照会） │
│   ├ 監査ログ（CloudWatch Logs）                                   │
│   ├ Secrets Manager から認証情報を取得して注入                      │
│   └ 配下のサービスへ中継                                           │
│         ├ MCP Servers / Custom Tools                              │
│         ├ Browser Worker（Playwright / Chrome）                   │
│         └ SAP・社内 DB・社内 API（VPN / PrivateLink など）          │
└───────────────────────────────────────────────────────────────┘
```

- セッション用トークンは Agent の設定（MCP の `transport.headers`）に入るため、モデルと OpenAI から見える。VPC 内からしか使えず、そのセッションで許可されたツールだけに限定され、有効期限が短く、セッション終了時に失効するので、見えても問題ない設計にする。
- Fargate では、同じタスク内のコンテナはタスクロールを共有する。認証情報を持つサービスを Session Worker と同じタスクのサイドカーにせず、別の ECS Service として分ける。

### 5.4 Runtime の提供形態

| | パターン A: Agent Studio 管理の AWS | パターン B: 顧客所有の AWS |
|---|---|---|
| 想定顧客 | 中小企業 | 大企業 |
| AWS アカウント | 当社の AWS Organizations の Companies OU 配下 | 顧客の AWS アカウント |
| 構築 | 当社が Terraform で構築（将来は自動化） | 顧客が CloudFormation（Quick Create リンク）または Terraform module で構築 |
| 業務システムへの接続 | Site-to-Site VPN / PrivateLink / IP 制限つき公開 API（§16 で決定） | 顧客のネットワーク内で完結 |
| Runtime の更新 | 当社が適用 | 顧客が適用（後方互換を保つ） |
| 登録時の紐づけ | AWS アカウント ID + IAM ロール + organization_id（どちらも同じ） | 同左 |

---

## 6. アクターと権限

| アクター | 権限の概要 |
|---|---|
| 運営管理者（Zerotry） | 組織の作成、Runtime のプロビジョニング。顧客データの閲覧は原則不可（break-glass のみ。SEC-17） |
| Owner | 組織の設定、メンバー、課金、実行環境の作成・削除 |
| Admin | メンバー管理、Connection・Tool・Policy の管理、production へのデプロイ |
| Builder | Agent・Workflow の作成・編集、staging へのデプロイ、テスト実行 |
| Operator | デプロイ済み Agent の実行、実行履歴の閲覧 |
| Approver（権限フラグ） | 承認依頼の承認・却下。他のロールと組み合わせて付与する |
| Viewer | 閲覧のみ |
| Runtime（機械の主体） | 登録済みの Runtime。自分宛てのジョブの取得と、自分のセッションの状態報告だけができる |
| 顧客の AWS 管理者（パターン B） | 自社 AWS への Runtime のデプロイと、認証情報の登録 |

---

## 7. 機能要件

フェーズ列は §15 の見直し案に対応する。

### 7.1 組織・ユーザー・認証（ORG）

| ID | 要件 | Phase |
|---|---|---|
| ORG-01 | 組織は不変の UUID を主キーにする。slug は表示と URL にだけ使い、権限の判定には使わない | 1 |
| ORG-02 | ユーザーは複数の組織に所属できる（`organization_members`）。操作中の組織はトークンに持たせる | 1 |
| ORG-03 | ロールは owner / admin / builder / operator / viewer に、approver の権限フラグを加えたもの | 1 |
| ORG-04 | メンバーの招待・削除・ロール変更 | 1 |
| ORG-05 | 操作する組織はヘッダ（`X-Organization-Id`）で選び、サーバーが毎回メンバーシップを確認する。リクエストのパスやボディで指定された組織は信用しない | 1 |
| ORG-06 | MFA | 1 |
| ORG-07 | SSO（SAML / OIDC）。大企業向け | 4 |
| ORG-08 | 組織を作成するとき、対応する OpenAI Project を紐づける（作成は手動でもよい。P-2 次第で自動化） | 1 |

### 7.2 Agent / Agent Manifest（AGT）

| ID | 要件 | Phase |
|---|---|---|
| AGT-01 | Agent Manifest（YAML/JSON）を Agent 定義の正本にし、Zod スキーマで検証する | 1 |
| AGT-02 | Manifest はバージョンで管理する。公開したバージョンは変更できない | 1 |
| AGT-03 | 日本語の説明から Manifest の案を生成する（生成に使う LLM は §16） | 1 |
| AGT-04 | バージョン間の差分表示とロールバック | 2 |
| AGT-05 【修正提案】 | Manifest には実行時の入力（例:「400円下げる」）を含めない。目的・指示・ツール・ポリシー・実行環境の参照だけを持つ | 1 |
| AGT-06 【修正提案】 | 実行環境は `runtime_id` を直接書かず、Environment（例: `sample-a/production`）を参照し、デプロイ時に Runtime を決める | 2 |

Manifest の例（修正後）:

```yaml
agent:
  id: pricing-agent            # 組織内で一意。内部では UUID で管理
  organization_id: org_sampleA # 保存時にサーバーが付与。ユーザーは指定しない
  name: 価格変更エージェント
instructions: |
  指定された商品の価格を、指示された金額だけ変更する。
  変更前後の価格を必ず確認して報告する。
tools:
  - ref: get_product@1
  - ref: update_price@2
policies:
  - type: approval
    tool: update_price
    condition: "abs(args.price_change) > 500"
deployment:
  environment: production      # Environment を参照。Runtime はデプロイ時に決まる
```

### 7.3 Agent Compiler（CMP）

| ID | 要件 | Phase |
|---|---|---|
| CMP-01 | Manifest を OpenAI の agent 設定（`model` / `instructions` / `reasoning` / `tools` / `metadata`）に変換する | 1 |
| CMP-02 | ツールを実行場所ごとに変換する: function tool / service MCP / environment MCP（Tool Gateway の URL とセッション用トークン） | 1〜3 |
| CMP-03 | Policy を、OpenAI 側の設定（`allowed_tools` など）と Tool Gateway 側のルールの両方に変換する | 2〜5 |
| CMP-04 | 変換結果を保存し、どの Run がどの設定で動いたかを追えるようにする | 1 |
| CMP-05 | 変換結果にシークレットの値が含まれないことを検査する | 1 |
| CMP-06 | `metadata` に organization_id / agent_version_id / deployment_id / run_id を入れる | 1 |
| CMP-07 | 出力先（OpenAI）を差し替えられる構造にする | 1 |

### 7.4 Workflow（WF）

| ID | 要件 | Phase |
|---|---|---|
| WF-01 | 複数のステップ（Agent の実行、承認、条件分岐）を定義できる | 2 |
| WF-02 | ステップごとに別の実行環境を指定できる（Hybrid） | 2 |
| WF-03 | 実行状態を保存し、承認待ちなどで長時間止まった後に再開できる | 2 |
| WF-04 | Phase 2 は直列と承認だけにし、並列・分岐は後のフェーズにする | 2 |

### 7.5 Tool Registry（TOOL）

| ID | 要件 | Phase |
|---|---|---|
| TOOL-01 | ツールは組織ごとに登録する。名前、説明、入力スキーマ（JSON Schema）、実行場所、使う Connection を持つ | 1 |
| TOOL-02 | 実行場所は `studio_function`（Agent Studio が実行）/ `openai_service_mcp`（OpenAI から接続する公開 MCP）/ `runtime_mcp`（顧客 Runtime 内、Tool Gateway 経由）/ `builtin`（シェル・ファイルなど）の 4 種類 | 1〜3 |
| TOOL-03 | ツールはバージョンで管理する。Agent は特定のバージョンに紐づく | 1 |
| TOOL-04 | リスク区分（読み取り / 書き込み / 外部送信 / 金額の変更など）を持ち、Policy の初期値に使う | 1 |
| TOOL-05 | `runtime_mcp` のツールは、Runtime 側の Tool Gateway にも登録されている場合にだけ使える（Agent Studio と Runtime の二重許可） | 3 |

### 7.6 Connections（CONN）

| ID | 要件 | Phase |
|---|---|---|
| CONN-01 | 接続先（SAP、DB、社内 API、Slack など）をメタデータとして登録する | 1 |
| CONN-02 | 認証情報の値は Agent Studio の DB に保存しない。参照名（`secret_refs`）だけを持つ | 1 |
| CONN-03 | Self-hosted の Connection の認証情報は、顧客 AWS の Secrets Manager に保存する | 3 |
| CONN-04 | `openai_service_mcp` の認証情報は OpenAI の vault に保存し、Agent Studio は `vault_id` だけを持つ | 1 |
| CONN-05 | 認証情報の入力経路を決める（§16） | 3 |
| CONN-06 | 接続テスト（Runtime 経由で疎通を確認し、結果だけを返す） | 5 |

### 7.7 Policy / 承認（POL）

| ID | 要件 | Phase |
|---|---|---|
| POL-01 | ポリシーの種類: 承認の要否、ツールの使用可否、引数の条件（例: `price_change > 500`）、実行時間帯、実行回数の上限 | 1〜5 |
| POL-02 | ポリシーはツールを実行する場所で強制する（`runtime_mcp` は Tool Gateway、`studio_function` は Agent Studio）。Agent の指示文に書くだけの制御にはしない | 3〜5 |
| POL-03 | 承認依頼を承認者に通知する（画面、メール、Slack）。承認・却下・期限切れを扱う | 2 |
| POL-04 | 承認は「ツール名 + 引数のハッシュ」に紐づけ、承認されたものと同じ呼び出しだけを許可する | 5 |
| POL-05 | 承認・却下を監査ログに記録する（誰が、何を、どの引数で） | 2 |
| POL-06 | ポリシーは組織 → Agent → ツールの順に継承し、厳しい方を優先する | 2 |
| POL-07 | ブラウザや外部データを読む Agent では、書き込み系ツールの承認を初期値で必須にする | 5 |

承認の実装方法は P-5（OpenAI 側の承認の仕組み）の結果で決める。仕組みがない場合、Tool Gateway は承認が必要な呼び出しを「承認待ち（approval_id）」として拒否し、承認後に Agent Studio がセッションに続きの入力を送り、同じ引数の再呼び出しだけを通す。

### 7.8 実行環境（ENV）

| ID | 要件 | Phase |
|---|---|---|
| ENV-01 | 実行環境の種類: OpenAI の環境 / Agent Studio が用意する AWS / 自社の AWS アカウント | 2 |
| ENV-02 | OpenAI の環境では Environment Template（`general-python` / `browser-basic` / `data-analysis` / `document-processing`）とネットワーク方針（`restricted` + `allowed_domains`）を管理する | 1〜2 |
| ENV-03 | Self-hosted は Runtime に紐づき、staging と production を分ける | 2〜3 |
| ENV-04 | 状態を表示する（準備中 / 接続済み / 異常 / 停止 / 失効） | 2 |
| ENV-05 | 画面の文言は日本語にする。例:「どこで実行しますか？」→「OpenAIの環境で実行」「Agent Studioが用意するAWSで実行」「自社のAWSアカウントで実行」 | 2 |

### 7.9 Deployment（DEP）

| ID | 要件 | Phase |
|---|---|---|
| DEP-01 | Agent のバージョンと実行環境の組み合わせを Deployment として作る | 2 |
| DEP-02 | デプロイ前に検証する: ツールが Runtime で使えるか、ポリシーが矛盾していないか、Runtime がオンラインか | 2〜3 |
| DEP-03 | staging から production への昇格 | 2 |
| DEP-04 | ロールバック | 2 |
| DEP-05 | production へのデプロイは admin 以上 | 2 |

### 7.10 実行（RUN）

| ID | 要件 | Phase |
|---|---|---|
| RUN-01 | 実行の起点: 画面 / API / スケジュール（EventBridge）/ webhook | 1〜2 |
| RUN-02 | OpenAI のセッションを作り、イベントを受け取り、Run の状態を保存する（queued / provisioning / running / waiting_approval / requires_action / completed / failed / cancelled） | 1 |
| RUN-03 | 実行中の様子を画面にストリーミング表示する（SSE） | 1 |
| RUN-04 | `studio_function` のツールを実行して結果を返す。ストリームが切れても webhook で回復できる | 1 |
| RUN-05 | 中止（`agent.session.input.cancel`）と、Runtime 側の Worker の停止 | 1〜3 |
| RUN-06 | 実行ログと成果物（`/workspace/outputs`）を S3 に保存する（組織ごとのプレフィックスと KMS キー） | 1 |
| RUN-07 | 実行コスト（トークン、コンテナの稼働時間）を記録する | 2 |
| RUN-08 | 終了時の後片付け（OpenAI セッションの削除、Worker の停止、トークンの失効）を保証する。取り残されたものを見つけて消すジョブを置く | 1〜3 |

### 7.11 Runtime Manager（RTM、Agent Studio 側）

| ID | 要件 | Phase |
|---|---|---|
| RTM-01 | Runtime を作成する（組織、環境、想定する AWS アカウント ID、想定する IAM ロール名、リージョン） | 3 |
| RTM-02 | Bootstrap Token を発行する（一度だけ有効、有効期限 24 時間、ハッシュで保存、想定アカウントに紐づく） | 3 |
| RTM-03 | 登録を受け付ける。Bootstrap Token と AWS の身元証明の両方を検証し、Runtime を active にする | 3 |
| RTM-04 | Runtime 用の短期アクセストークンを、AWS の身元証明と引き換えに発行する（有効期間 15 分程度） | 3 |
| RTM-05 | ジョブは Runtime Controller がアウトバウンドの HTTPS（long-poll）で取りに来る。自分宛てのジョブしか取れない | 3 |
| RTM-06 | ハートビートを監視し、状態（active / degraded / offline / revoked）を管理する | 3 |
| RTM-07 | Runtime を即時に失効させる（以後のトークン発行を拒否し、環境キーをローテーションする） | 3〜4 |
| RTM-08 | Runtime Controller のバージョンを管理し、互換性を確認する | 3 |

### 7.12 Company Runtime（CRT）

| ID | 要件 | Phase |
|---|---|---|
| CRT-01 | Runtime Controller: ジョブの取得、Session Worker の起動・停止、状態報告 | 3 |
| CRT-02 | Session Worker: セッションごとに 1 タスク。終了後に破棄する。最大寿命とアイドルタイムアウトを持つ | 3 |
| CRT-03 | Session Worker: 業務システムの認証情報と AWS の権限を持たない（環境キーだけ） | 3 |
| CRT-04 | Tool Gateway: VPC 内の MCP エンドポイント、トークン検証、ツールの許可判定、ポリシー判定、承認の照会、監査、Secrets の取得 | 3（最小）〜5 |
| CRT-05 | MCP Servers / Custom Tools は Tool Gateway の配下で動かす | 5 |
| CRT-06 | Browser Worker: Playwright / Chrome。セッションごとにブラウザのコンテキストを分ける。ログイン情報は Browser Worker 側で入力し、Agent には渡さない | 5 |
| CRT-07 | 外部からのインバウンド通信を受けない。アウトバウンドは許可リストのみ（Agent Studio の Runtime API、`api.openai.com`、`codex-cloud-environments.chatgpt.com`、許可した社内 CIDR） | 3 |
| CRT-08 | ログは顧客 AWS の CloudWatch Logs に出す。Agent Studio に送るのはメタデータと状態だけ（本文を送るかは設定で選ぶ） | 3 |
| CRT-09 | コンテナイメージは Agent Studio が署名して配布し、Runtime は署名を検証したイメージだけを起動する | 4 |
| CRT-10 | 顧客独自のツールを追加できる（パターン B では顧客がイメージを提供する） | 5 |
| CRT-11 | Runtime 側のツール許可リストは顧客側でも管理でき、Agent Studio だけでは広げられない（パターン B） | 5 |

### 7.13 Provisioning（PRV）

| ID | 要件 | Phase |
|---|---|---|
| PRV-01 | Terraform module `tenant-runtime` で一式を構築する（VPC、Subnets、NAT、ECS、IAM、KMS、Secrets、Logs、Runtime Controller、Tool Gateway） | 3 |
| PRV-02 | パターン A: AWS Organizations の配下にアカウントを作り module を適用する（Phase 3 は手動、Phase 6 で自動化） | 3 / 6 |
| PRV-03 | パターン B: CloudFormation テンプレート（Quick Create リンク）と Terraform module を提供する | 6 |
| PRV-04 | 構築の進捗を画面に表示する（AWS アカウント、VPC、ECS…） | 6 |
| PRV-05 | パターン A で、申し込みから接続完了まで 10 分以内 | 6 |
| PRV-06 | テナントの追加は `config.yaml` の追加だけで行える | 3 |

### 7.14 Eval（EVAL）

| ID | 要件 | Phase |
|---|---|---|
| EVAL-01 | Agent ごとにテストケース（入力、期待する結果、してはいけないこと）を登録する | 7 |
| EVAL-02 | Agent のバージョン同士を比べて実行する | 7 |
| EVAL-03 | デプロイの条件に Eval の合格を設定できる | 7 |

### 7.15 監査ログ（AUD）

| ID | 要件 | Phase |
|---|---|---|
| AUD-01 | すべての操作を記録する（ログイン、設定変更、デプロイ、実行、承認、ツール呼び出し、シークレットの参照、Runtime の登録・失効） | 1 |
| AUD-02 | 記録項目: 実行者（ユーザー / Runtime / システム）、組織、操作、対象、日時、接続元、結果 | 1 |
| AUD-03 | 追記だけを許可する（アプリの DB ロールに UPDATE / DELETE 権限を与えない）。S3 Object Lock に定期的に書き出す | 1 / 4 |
| AUD-04 | 組織の管理者が自組織の監査ログを閲覧・エクスポートできる | 2 |
| AUD-05 | Runtime 側（Tool Gateway）の監査は顧客の CloudWatch Logs にも残し、要約を Agent Studio に送る | 3 |

### 7.16 課金（BILL）

| ID | 要件 | Phase |
|---|---|---|
| BILL-01 | 組織ごとの利用量（トークン、セッション数、実行時間、Runtime の稼働）を集計する | 2 |
| BILL-02 | OpenAI の利用量は、企業ごとの Project 単位で照合する | 2 |
| BILL-03 | パターン A の AWS コストは、アカウント単位で企業に割り当てる | 6 |
| BILL-04 | 料金体系（§16） | 7 |

---

## 8. 主要フロー

### 8.1 Runtime の登録

```text
運営管理者           Agent Studio                          顧客 AWS（Runtime Controller）
    │ 1. Runtime を作成                                       │
    │   （組織・環境・想定 AWS アカウント ID・想定ロール名）   │
    ├──────────────▶ runtime（status=pending）                 │
    │               2. Bootstrap Token を発行                 │
    │                  （一度だけ・24時間・ハッシュ保存）      │
    │ 3. Terraform apply（token を Secrets Manager に格納）──────▶ 起動
    │                                                         │
    │               ◀── 4. 登録要求: token + 署名済み GetCallerIdentity
    │               5. STS に転送して、呼び出し元の ARN を得る  │
    │                  ・アカウント ID が想定と一致するか        │
    │                  ・ロール名が想定と一致するか              │
    │                  ・token の runtime が一致し、未使用で期限内か
    │               6. token を失効（原子的に）、runtime=active │
    │               7. 環境キーと設定を返す ───────────────────▶ Secrets Manager に保存
    │                                                         │ 手元の Bootstrap Token を削除
    │               ◀── 8. 以後は署名済み GetCallerIdentity で短期トークンを取得し、
    │                      ジョブの取得と状態報告を行う
```

- 署名済み GetCallerIdentity には、Agent Studio 固有の値（例: `X-AgentStudio-Server-ID`）を署名対象のヘッダとして含め、他のサービス向けに作られた署名の使い回しを防ぐ。
- Bootstrap Token だけでは登録できない（AWS の身元が想定と一致することが必須）。

### 8.2 Self-hosted の実行

```text
 1. ユーザーが実行する（org_A、価格変更エージェント、production）
 2. Agent Studio: 認可（ユーザーの組織 = Agent の組織 = Deployment の組織 = Runtime の組織）
 3. Agent Studio: A社の OpenAI Project のアプリキーでセッションを作成（environment.type = self_hosted）
      → session_id / environment.id / environment.remote_url
 4. Agent Studio: Run を保存し、A社 Runtime 宛てのジョブを作成
      { run_id, session_id, environment_id, remote_url, 許可するツールの一覧 }
 5. Runtime Controller: ジョブを取得し、セッション用トークンを発行して Tool Gateway にセッションを登録
 6. Runtime Controller: ecs:RunTask（Session Worker）
 7. Session Worker: codex exec-server --remote … --environment-id …
      （CODEX_API_KEY = 環境キー）→ OpenAI へアウトバウンドの WSS
 8. OpenAI: agent.session.environment.connected → Agent Studio が入力を送る（P-10）
 9. 実行: シェル・ファイル操作は Worker 内。業務ツールは Worker → Tool Gateway（MCP）→ SAP など
10. 承認が必要なツール: Tool Gateway → Controller → Agent Studio（承認依頼）→ 承認者
11. 完了: agent.session.turn.completed → Agent Studio が結果を保存 → 終了の指示
      → Worker の停止、セッション用トークンの失効、OpenAI セッションの削除
```

### 8.3 OpenAI-hosted の実行

```text
1. ユーザーが実行 → 認可
2. Agent Studio: 企業の OpenAI Project のアプリキーでセッションを作成
   （environment.type = openai_hosted、environment_template_id、ネットワーク方針）
3. OpenAI がサンドボックスを用意して実行
4. イベントを受信・保存。function tool は Agent Studio が実行
5. 完了後、成果物（/workspace/outputs）を S3 に保存し、セッションを削除
```

### 8.4 Runtime の失効（事故対応）

```text
1. Agent Studio: runtime を revoked にする → 短期トークンの発行を停止、未処理のジョブを取り消す
2. OpenAI: その企業の環境キーを失効させ、再発行する
3. 実行中のセッションを中止する（agent.session.input.cancel）
4. 顧客側（パターン B）: Runtime Controller を停止すれば、いつでも一方的に切り離せる
```

---

## 9. セキュリティ要件

### 9.1 必須の 10 原則と実装方法

| # | 原則 | 実装方法 | Phase |
|---|---|---|---|
| SEC-01 | 組織単位で全データを分離 | 全テーブルに `organization_id`、複合外部キー（SEC-16）、S3 は組織ごとのプレフィックスと KMS | 1 |
| SEC-02 | Self-host Runtime は AWS アカウント単位で分離 | 企業 × 環境ごとに AWS アカウントを分ける。SCP でガードレールをかける | 3 |
| SEC-03 | ユーザーのトークンに組織を紐づける | 操作中の組織をトークンに持たせ、サーバー側でメンバーシップを再確認する | 1 |
| SEC-04 | PostgreSQL の RLS | §10.2 | 1 |
| SEC-05 | Runtime 登録時に AWS の身元を検証 | 署名済み `sts:GetCallerIdentity` の検証（§8.1） | 3 |
| SEC-06 | Bootstrap Token は一度だけ | 原子的に消費、ハッシュ保存、24 時間の期限、想定アカウントに紐づけ | 3 |
| SEC-07 | Secrets は顧客 AWS 側 | Agent Studio の DB には `secret_refs` だけ。値は顧客の Secrets Manager（KMS の顧客管理キー） | 3 |
| SEC-08 | 完全な権限の OpenAI API キーを顧客 Runtime に渡さない | Runtime に渡すのは環境キーだけ。アプリキーは Agent Studio の Secrets Manager にだけ置く | 3 |
| SEC-09 | Self-host Worker はセッション単位で隔離 | セッションごとの Fargate タスク、終了後に破棄、ワークスペースは共有しない | 3 |
| SEC-10 | 全操作を監査ログに記録 | AUD-01〜05 | 1 |

### 9.2 追加のセキュリティ要件【追加提案】

| # | 要件 | 理由 | Phase |
|---|---|---|---|
| SEC-11 | 企業ごとに OpenAI Project を分ける（アプリキーと環境キーも企業ごと） | 環境キーの効く範囲をプロジェクト内に閉じ、他社セッションへの接続を構造的に防ぐ | 1〜3 |
| SEC-12 | Executor を信頼しない。認証情報と IAM 権限を Session Worker に置かない | エージェントが生成したコードは環境内のものをすべて読める | 3 |
| SEC-13 | 業務ツールには Tool Gateway 経由でしかアクセスできない。ポリシーは Tool Gateway で強制する | モデルの判断や指示文に頼らない | 3〜5 |
| SEC-14 | Session Worker の通信を制限する。アウトバウンドは許可リストのみ、VPC 内の到達先はセキュリティグループで Tool Gateway だけにする | 踏み台として社内ネットワークに広がるのを防ぐ | 3 |
| SEC-15 | Runtime 認証のリプレイ対策（Agent Studio 固有のヘッダを署名対象にする、署名時刻の許容幅を短くする） | 署名済みリクエストの使い回しを防ぐ | 3 |
| SEC-16 | DB の外部キーを `(organization_id, id)` の複合キーにし、組織をまたいだ参照を禁止する | 例: A社の Agent に B社のツールを紐づけるバグを DB で止める | 1 |
| SEC-17 | 運営者による顧客データへのアクセスは break-glass（理由の入力、時間制限、監査）のみ | 内部の人による不正と事故を防ぐ | 4 |
| SEC-18 | プロンプトインジェクション対策（外部データを読む Agent の書き込み系ツールは承認を必須にする） | Web ページ経由で不正な更新をさせられるのを防ぐ | 5 |
| SEC-19 | コンテナイメージの署名と脆弱性スキャン | 供給経路の改ざんを防ぐ | 4 |
| SEC-20 | キーのローテーション（環境キー、アプリキー、KMS） | 漏えいしたときの影響を小さくする | 4 |
| SEC-21 | 顧客に開示する: OpenAI に送られるデータの範囲、米国での処理、ZDR 非対応 | Self-hosted でもデータは OpenAI に送られる（§4.2-A） | 1 |

### 9.3 脅威と対策

| 脅威 | 対策 |
|---|---|
| B社の Runtime が A社を名乗る | AWS の身元（アカウント ID + ロール）で判定する。自己申告の organization_id は使わない |
| Bootstrap Token が漏れる | 一度だけ有効、期限あり、想定アカウントとの一致が必須（token だけでは登録できない） |
| アプリのバグで A社ユーザーが B社のデータを見る | RLS + 複合外部キー + トークン由来の organization_id |
| エージェントが認証情報を読み取り、モデル経由で外に出る | 認証情報を Executor に置かず、Tool Gateway で保持・注入する |
| エージェントがタスクロールの権限で顧客 AWS を操作する | Session Worker のタスクロールに権限を持たせない |
| 環境キーが漏れる | 環境接続の権限しかない、企業ごとのプロジェクト、ローテーション |
| 他社セッションの Executor になりすます | 企業ごとの OpenAI Project（P-3 で確認） |
| Web ページ経由のプロンプトインジェクションで不正に更新させられる | Tool Gateway のポリシー・承認・引数の条件 |
| Session Worker を踏み台に社内ネットワークへ広がる | セキュリティグループで Tool Gateway 以外への到達を遮断 |
| Agent Studio が侵害され、顧客環境に被害が及ぶ | Runtime は pull 型で、Agent Studio は顧客 AWS の IAM 権限を持たない（パターン B）。Runtime 側の許可リスト（CRT-11）の範囲でしか動かない |

---

## 10. データモデル

### 10.1 テーブル一覧（主な列）

`organization_id` は組織に属するすべてのテーブルに持たせる（`users` と `organizations` 以外）。

| テーブル | 主な列 | 備考 |
|---|---|---|
| organizations | id, slug, name, status | slug は表示用 |
| organization_openai_projects | organization_id, openai_project_id, app_key_secret_arn, env_key_id | 【追加提案】SEC-11 |
| users | id, email, auth_subject | |
| organization_members | organization_id, user_id, role, is_approver | |
| agents / agent_versions | id, organization_id, agent_id, version, manifest, compiled_config, status | 公開したバージョンは変更不可 |
| workflows / workflow_versions | id, organization_id, definition, status | |
| connections | id, organization_id, type, name, runtime_id, secret_ref_id | 値は持たない |
| tools / tool_versions | id, organization_id, name, execution_location, input_schema, risk_level, connection_id | |
| agent_tools | organization_id, agent_version_id, tool_version_id | 複合外部キー |
| policies | id, organization_id, scope_type, scope_id, rule | |
| runtime_profiles | id, organization_id, type, stage, template_id, runtime_id | 実行環境の設定（ENV） |
| runtimes | id, organization_id, stage, provisioning_type, aws_account_id, aws_region, expected_role_name, status, controller_version, last_heartbeat_at | |
| runtime_bootstrap_tokens | id, organization_id, runtime_id, token_hash, expires_at, consumed_at | 【追加提案】 |
| runtime_instances | id, organization_id, runtime_id, version, last_heartbeat_at | |
| runtime_jobs | id, organization_id, runtime_id, run_id, type, payload, status, leased_until | 【追加提案】ジョブの配送 |
| deployments | id, organization_id, agent_version_id, runtime_profile_id, stage, status | |
| runs | id, organization_id, deployment_id, status, input, requested_by, cost | |
| sessions | id, organization_id, run_id, openai_session_id, openai_environment_id, runtime_id, worker_task_arn, status | |
| approvals | id, organization_id, run_id, tool_name, args_hash, args_preview, status, decided_by, expires_at | |
| evals / eval_cases / eval_runs | id, organization_id, agent_id, … | |
| secret_refs | id, organization_id, runtime_id, name, provider, locator | locator は ARN や vault_id。値は持たない |
| audit_logs | id, organization_id, actor_type, actor_id, action, target, result, source_ip, created_at | 追記のみ |

### 10.2 RLS の方針

- 組織に属するテーブルには `organization_id uuid not null` を持たせ、`ENABLE ROW LEVEL SECURITY` を設定する。
- アプリが使う DB ロールには `BYPASSRLS` を付けず、テーブルの所有者にもしない（所有者は RLS の対象外になるため）。
- 組織をまたぐ必要がある処理（ログイン時の利用者の解決、Runtime の身元の照合、Worker のジョブ取得など）は、所有者の権限で動く `SECURITY DEFINER` 関数に閉じ込め、アプリのロールにだけ実行を許可する。
  （実装メモ: 当初は `FORCE ROW LEVEL SECURITY` を想定していたが、`FORCE` にすると `SECURITY DEFINER` 関数も RLS の対象になるため `ENABLE` にした）
- リクエストごとに、トランザクションの中で `set_config('app.organization_id', <id>, true)` を実行する（Prisma の Client Extension で共通化する）。
- ポリシーは `organization_id = current_setting('app.organization_id', true)::uuid`。設定されていない場合はどの行も見えない。
- `SET LOCAL` 相当（トランザクション内だけ有効）にするので、RDS Proxy などの接続プールとも併用できる。
- 運営用・バッチ用のロールは別に作り、使った操作はすべて監査する。
- 他組織のデータが見えないことを、CI の自動テストで確認する。

---

## 11. 非機能要件

| ID | 分類 | 要件 |
|---|---|---|
| NFR-01 | 可用性 | Control Plane は月間 99.9% を目標にする（Multi-AZ）。Runtime の障害は他の企業に影響しない |
| NFR-02 | 性能 | 実行開始から Executor 接続までを p95 で 90 秒以内にする（Fargate の起動を含む。P-1 で実測して確定） |
| NFR-03 | 性能 | 画面操作の API 応答を p95 で 500ms 以内にする（Agent 実行を除く） |
| NFR-04 | 拡張性 | 同じ module で 1,000 社まで増やせる。Terraform の state はテナント × 環境ごとに分ける。AWS Organizations のアカウント数の上限は事前に引き上げを申請する |
| NFR-05 | 同時実行 | 企業ごとに同時セッション数の上限を設定できる |
| NFR-06 | 監視 | Control Plane のメトリクスとアラート。全 Runtime のハートビートを一覧で見られる |
| NFR-07 | バックアップ | RDS のポイントインタイムリカバリ、S3 のバージョニング。RPO 5 分、RTO 4 時間を目安にする |
| NFR-08 | データ保持 | 実行ログと監査ログの保持期間を決める（§16） |
| NFR-09 | コスト | テナントごとの固定費を見積もり、料金に反映する（下の表） |
| NFR-10 | 言語 | 画面の文言は日本語。技術用語を使わず、利用者が分かる言葉にする |
| NFR-11 | 保守 | Runtime Controller と Tool Gateway は 2 バージョン前まで後方互換を保つ（パターン B は顧客が更新するため） |

テナントごとの固定費の主な要因（東京リージョン、概算。正式な見積もりは Phase 3 で行う）:

| 項目 | 目安 |
|---|---|
| NAT Gateway | 約 $45/月/AZ + 通信量 |
| Runtime Controller + Tool Gateway（常駐の Fargate） | 小さい構成で月 数十ドル |
| KMS キー | $1/月/キー |
| Secrets Manager | $0.40/月/シークレット |
| VPC エンドポイント（使う場合） | 約 $10/月/エンドポイント/AZ |
| AWS Network Firewall（通信先を FQDN で制限する場合） | 約 $290/月/AZ。§16 で代替案を検討する |
| Session Worker | 実行時間に応じた従量課金（1 回あたりは小さい） |

---

## 12. AWS 構成要件

### 12.1 AWS Organizations

```text
Management（請求と Organizations の管理だけ。ワークロードは置かない）
├── Security OU【追加提案】
│    ├── log-archive        CloudTrail 組織証跡、Config、監査ログの保管
│    └── security-tooling   GuardDuty、Security Hub
├── Platform OU
│    ├── agent-studio-prod
│    ├── agent-studio-staging
│    └── shared-services【追加提案】  ECR（Runtime のイメージ）、CI/CD
└── Companies OU
     ├── sample-a-company-prod
     ├── sample-a-company-staging
     ├── sample-b-company-prod
     └── sample-c-company-prod

SCP（Companies OU）の例: 使えるリージョンを ap-northeast-1 に限定、CloudTrail の停止を禁止、
IAM ユーザーの作成を禁止、Organizations からの離脱を禁止
```

### 12.2 Control Plane（agent-studio-prod）

| 構成要素 | AWS サービス |
|---|---|
| 配信 | CloudFront + WAF → ALB |
| Web | ECS Fargate（Next.js の standalone 出力） |
| API | ECS Fargate（Hono） |
| 非同期処理 | ECS Fargate（Worker）+ SQS |
| Runtime API | 別のホスト名にし、WAF のルールを分ける |
| DB | RDS for PostgreSQL（Multi-AZ） |
| キャッシュ・イベント配信 | ElastiCache（Redis） |
| ファイル | S3（組織ごとのプレフィックス、SSE-KMS） |
| スケジュール | EventBridge Scheduler |
| シークレット | Secrets Manager（企業ごとの OpenAI アプリキー） |
| 暗号鍵 | KMS |
| 監視 | CloudWatch、X-Ray |

### 12.3 テナント Runtime module（`infra/modules/tenant-runtime`）

入力:

```yaml
organization_id: 0b9d...        # UUID
organization_slug: sample-a-company
runtime_id: 5f1c...             # Agent Studio で作成した Runtime の ID
environment: production
region: ap-northeast-1
agent_studio_runtime_api: https://runtime-api.agent-studio.example
browser_enabled: true
mcp_enabled: true
allowed_internal_cidrs:
  - 10.10.0.0/16
session_worker:
  cpu: 1024
  memory: 2048
  max_concurrent: 10
  max_lifetime_minutes: 120
  idle_timeout_minutes: 15
```

作られるもの: VPC、Private Subnet（Public Subnet は NAT 用だけ）、NAT、ECS クラスター、Runtime Controller、Tool Gateway、Session Worker のタスク定義、IAM ロール（Controller 用 / Tool Gateway 用 / 権限なしの Session Worker 用）、KMS キー、Secrets Manager、CloudWatch Logs、セキュリティグループ。

出力: `runtime_role_arn`（Agent Studio に登録する IAM ロール）など。

### 12.4 命名とタグ

- 名前: `as-{tenant}-{env}-{component}`（例: `as-sample-a-prod-runtime`）。Agent Studio 本体は `as-prod-api` など。
- 必須タグ: `agentstudio:organization_id`、`agentstudio:runtime_id`、`agentstudio:environment`、`agentstudio:component`
- 権限の判定に名前は使わない。判定は organization の UUID、AWS アカウント ID、IAM プリンシパルで行う。

---

## 13. リポジトリ構成（案）

zerotry の標準（Yarn 4、frontend / backend の分離）に合わせる。

```text
agent-studio/
├── frontend/                 # Next.js（App Router）
├── backend/                  # Hono の API と非同期 Worker
├── runtime/                  # 顧客 AWS で動くもの（本体とは別にバージョン管理・リリースする）
│   ├── controller/           # Runtime Controller
│   ├── tool-gateway/         # Tool Gateway
│   ├── session-worker/       # codex exec-server のコンテナイメージ
│   └── browser-worker/
├── packages/
│   ├── manifest/             # Agent Manifest のスキーマ（Zod）と Compiler
│   └── shared/               # 共通の型と処理
├── infra/
│   ├── modules/              # 元案の infra/agent-studio/modules と infra/modules を 1 つにまとめる
│   │   ├── control-plane/
│   │   ├── tenant-runtime/
│   │   ├── network/
│   │   ├── ecs/
│   │   ├── secrets/
│   │   ├── browser-worker/
│   │   └── mcp-runtime/
│   ├── agent-studio/
│   │   ├── staging/
│   │   └── production/
│   └── company/
│       ├── sample-a-company/ # slug と同じ名前にする（元案は sampleAcompany）
│       │   ├── config.yaml
│       │   ├── staging/
│       │   └── production/
│       └── sample-b-company/
└── docs/
```

---

## 14. 技術スタック

| レイヤー | 採用 | 備考 |
|---|---|---|
| フロントエンド | Next.js 14（App Router）/ React 18 / Tailwind CSS | zerotry 標準 |
| バックエンド | Hono / TypeScript | zerotry 標準 |
| ORM | Prisma 7 | RLS 用の Client Extension を作る |
| DB | RDS for PostgreSQL | **zerotry 標準（Supabase）から変更**。AWS 内で完結させ、RLS 用の DB ロールを細かく制御するため |
| 認証 | 未決（§16） | Cognito か Supabase Auth |
| Agent 実行 | OpenAI Agents API（ベータ） | |
| 日本語 → Manifest の生成 | 未決（§16） | zerotry 標準は Claude |
| Runtime Controller / Tool Gateway | TypeScript（Node.js）、AWS SDK v3 | |
| IaC | Terraform（パターン B 向けに CloudFormation も） | |
| CI/CD | GitHub Actions（AWS へは OIDC で接続） | |
| バリデーション | Zod | zerotry 標準 |

---

## 15. 開発フェーズ（見直し案）

| Phase | 内容 | 元案からの変更 | 完了条件 |
|---|---|---|---|
| 0 技術検証（1〜2 週） | P-1〜P-10 の PoC。検証用の AWS アカウントで、Fargate 上の exec-server を OpenAI に接続する | 新規 | Fargate 上の exec-server でセッションが最後まで完了する。環境キーの発行方法が確定する |
| 1 Core | 組織・認証、Agent・Manifest、Compiler、Tool Registry（function / service MCP）、Connections（メタデータ）、基本の Policy、OpenAI-hosted での実行、Runs・ログ、**RLS・複合外部キー・監査ログ**、企業ごとの OpenAI Project | RLS と監査ログを Phase 4 から前倒し | 日本語 → Agent → OpenAI-hosted で実行できる。他組織のデータに触れないことを自動テストで確認できる |
| 2 実行環境の抽象化 | runtime_profiles、deployments、Workflow（直列 + 承認）、staging / production、承認の通知 | Workflow の範囲を明確にした | OpenAI の環境と Self-hosted を同じ画面で選べる（Self-hosted は登録待ちの状態まで） |
| 3 Self-host Runtime | `tenant-runtime` module、`company/sample-a-company`、Runtime Controller、Session Worker、**Runtime 登録（Bootstrap + AWS の身元検証）**、最小の Tool Gateway | AWS の身元検証と Bootstrap を Phase 4 から前倒し（Runtime 登録と切り離せないため） | sample-a-company で Self-hosted の実行が完了し、Worker が破棄される |
| 4 マルチテナントの強化 | 環境キーのローテーション、Runtime の失効手順、break-glass、監査ログの S3 保全、SSO、イメージ署名、ペネトレーションテスト | 残りのセキュリティ項目をまとめた | §9.3 の各項目を検証済み |
| 5 MCP / Browser | Tool Gateway の本格化、Private MCP、Browser Worker、SAP・社内 API のコネクタ、引数条件つきの承認 | − | §1.3 の受け入れシナリオが通る |
| 6 自動プロビジョニング | パターン A のアカウント自動作成、パターン B の CloudFormation Quick Create、進捗表示 | − | 申し込みから 10 分以内に接続完了 |
| 7 以降 | Eval、課金、運用ダッシュボード | 元案のフェーズに入っていなかったもの | − |

---

## 16. 未決事項（判断が必要なこと）

| # | 論点 | 選択肢 | 推奨 |
|---|---|---|---|
| D-1 | 認証基盤 | Cognito / Supabase Auth（zerotry 標準）/ Auth0・Clerk | **Cognito**。AWS 内で完結し、大企業向けの SAML 連携も標準で使える。zerotry 標準との統一を優先するなら Supabase Auth |
| D-2 | DB | RDS for PostgreSQL / Aurora Serverless v2 | MVP は **RDS for PostgreSQL**（コストが読みやすい）。負荷が見えてから Aurora を検討する |
| D-3 | Runtime と Control Plane の通信方式 | (a) 署名済み GetCallerIdentity + 短期トークン + long-poll / (b) 企業ごとの SQS キュー（IAM で制御）/ (c) EventBridge のアカウント間連携 | **(a)**。どちらのパターンでも同じ実装で済み、Agent Studio 側に企業ごとの AWS リソースを作らなくてよい |
| D-4 | Tool Gateway の導入 | 導入する / Executor に認証情報を直接渡す | **導入する**（§4.2-B。Executor に渡すとモデルから読める） |
| D-5 | OpenAI Project の単位 | 企業ごと / 全社で共有 | **企業ごと**（SEC-11。利用量の集計も楽になる） |
| D-6 | Session Worker の通信先の制限方法 | Network Firewall（約 $290/月/AZ）/ Route 53 Resolver DNS Firewall + セキュリティグループ / 送信プロキシ（Squid など） | MVP は **DNS Firewall + セキュリティグループ**、厳しい顧客には Network Firewall をオプションで提供 |
| D-7 | パターン A で顧客の社内システムに繋ぐ方法 | Site-to-Site VPN / PrivateLink / IP 制限つきの公開 API | 顧客の状況で変わる。最初の顧客（Sample A）の環境を確認したい |
| D-8 | Self-hosted の認証情報の入力経路 | (a) 画面で入力し、Runtime の公開鍵でブラウザ側で暗号化して中継（Agent Studio は平文を見ない）/ (b) 顧客が自社 AWS のコンソールで直接登録 / (c) Agent Studio がアカウント間ロールで書き込む（保存はしないが平文が通る） | パターン B は **(b)**。パターン A は **(a)** を目標にし、MVP は (b) の運用で代用する |
| D-9 | 「日本語 → Manifest」の生成に使う LLM | Claude（zerotry 標準）/ OpenAI | どちらでもよい。Manifest の生成は実行と切り離せるので、精度で選ぶ |
| D-10 | Workflow の実行基盤 | 自前（Postgres + SQS）/ AWS Step Functions | MVP は **自前**（承認待ちが長く、状態を DB で持つ方が画面と連携しやすい） |
| D-11 | データの所在地（米国のみ、ZDR 不可） | 受け入れる / 対象顧客を絞る / 別の実行基盤を検討する | **ビジネス判断**。想定顧客（SAP を使う大企業など）が受け入れられるか、先に確認したい |
| D-12 | Company Runtime の staging | 全社に用意する / 希望する企業だけ | 希望する企業だけ（固定費が 2 倍になるため） |
| D-13 | ログ・監査ログの保持期間 | 例: 実行ログ 90 日、監査ログ 1 年以上 | 契約・業界の要件次第 |
| D-14 | 料金体系 | 席数 / 従量 / 固定費 + 従量 | Phase 7 までに決める。テナントの固定費（§11）を下回らないようにする |
| D-15 | パターン B の提供形式 | CloudFormation / Terraform / 両方 | 最初は **CloudFormation**（大企業の AWS 管理者に受け入れられやすい）。Terraform は求めに応じて |

---

## 17. 参考資料

- [Self-hosted sandboxes | OpenAI API](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted)
- [OpenAI-hosted sandboxes | OpenAI API](https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted)
- [Configuration | OpenAI API](https://developers.openai.com/api/docs/guides/agents-api/configuration)
- [MCP connections | OpenAI API](https://developers.openai.com/api/docs/guides/agents-api/tools/mcp)
- [Architecture | OpenAI API](https://developers.openai.com/api/docs/guides/agents-api/architecture)
- [Agents API overview | OpenAI API](https://developers.openai.com/api/docs/guides/agents-api/overview)
- [Agents API quickstart | OpenAI API](https://developers.openai.com/api/docs/guides/agents-api/quickstart)
- [Run and continue sessions | OpenAI API](https://developers.openai.com/api/docs/guides/agents-api/sessions)
