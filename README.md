# Agent Studio

企業ごとに分離された実行環境で、業務用の AI エージェントを設計・デプロイ・実行・監査する SaaS。

- **Agent Studio（Control Plane）**: 利用者・組織、Agent の定義（Manifest）、ツール、ポリシー・承認、デプロイ、実行履歴、監査ログ
- **Company Runtime（Execution Plane）**: 企業ごとの AWS アカウントで動く実行環境。`codex exec-server`（セッションごとの Fargate タスク）と、業務システムの認証情報を持つ Tool Gateway
- エージェントの実行は OpenAI Agents API（`openai_hosted` / `self_hosted`）

設計の詳細は [docs/requirements.md](docs/requirements.md)（要件定義書）と [docs/architecture/](docs/architecture/) を参照。

## ディレクトリ

```text
agent-studio/
├── packages/contracts/     # 共通のスキーマ・型（Manifest、ポリシー、API、Runtime プロトコル）
├── backend/api/            # API（Hono）と Worker（OpenAI のセッションを動かす）
├── frontend/web/           # Web（Next.js App Router）
├── runtime/
│   ├── controller/         # Runtime Controller（ジョブ取得・Session Worker の起動）
│   ├── tool-gateway/       # Tool Gateway（MCP・認可・ポリシー・承認・認証情報の注入）
│   ├── session-worker/     # codex exec-server のイメージ
│   ├── browser-worker/     # Playwright MCP のイメージ
│   └── demo-internal-api/  # 受け入れシナリオ用の社内 API モック
├── prisma/                 # DB スキーマとマイグレーション（RLS を含む）
├── infra/                  # Terraform（bootstrap / control-plane / tenant-runtime / 企業ごとの設定）
├── .github/workflows/      # CI・デプロイ
└── docs/                   # 要件定義書・設計・API
```

## ローカル開発

必要なもの: Node.js 22、Yarn 4（`corepack enable`）、Docker

```bash
yarn install
cp .env.example .env        # ローカル用の設定（下の「.env」を参照）
yarn db:up                  # PostgreSQL（localhost:5434）
yarn db:bootstrap           # アプリ用ロール（RLS が効く）を作る
yarn prisma:migrate:deploy
yarn prisma:generate
yarn workspace @agent-studio/contracts build
yarn prisma:seed            # Sample A 社・B 社などのデータ
```

起動（それぞれ別のターミナルで）:

```bash
yarn dev:api       # http://localhost:3200
yarn dev:worker
yarn dev:web       # http://localhost:3201
```

`.env` のローカル向けの主な値:

| 変数 | 値 | 意味 |
|---|---|---|
| `AUTH_MODE` | `dev` | `Authorization: Bearer dev:<email>` でログインできる（本番では起動しない） |
| `AGENTS_API_MODE` | `fake` | OpenAI を呼ばずに擬似的なセッションで動かす。`openai` にして `OPENAI_API_KEY` を入れると本物を使う |
| `SECRETS_MODE` | `memory` | シークレットをメモリに保存（再起動で消える） |
| `RUNTIME_IDENTITY_MODE` | `dev` | Runtime の身元を `dev://<アカウントID>/<ロール名>` で受け付ける |

シードのユーザー: `admin@example.com`（運営管理者）、`owner@sample-a.example`（Sample A 社の owner・承認者）、`operator@sample-a.example`、`owner@sample-b.example`

ローカルで Runtime（Controller・Tool Gateway・社内 API モック）を動かす方法は [runtime/README.md](runtime/README.md)。

## テスト

```bash
yarn type-check
yarn test                                          # 単体テスト（全ワークスペース）
yarn workspace @agent-studio/api test:integration  # 結合テスト（PostgreSQL が必要）
```

結合テストでは、組織の分離（RLS・複合外部キー・監査ログの追記のみ）と、実行の流れ（Runtime の登録、承認、後片付け）を確認する。

## CI/CD

| ワークフロー | いつ | 内容 |
|---|---|---|
| [ci.yml](.github/workflows/ci.yml) | PR・main への push | 型チェック、単体テスト、ビルド、マイグレーションと差分、結合テスト、Terraform の fmt/validate、イメージのビルド |
| [deploy-control-plane.yml](.github/workflows/deploy-control-plane.yml) | main への push（staging）・手動（production） | イメージの push → マイグレーション → ECS の更新 → ヘルスチェック |
| [deploy-runtime.yml](.github/workflows/deploy-runtime.yml) | main への push（staging）・手動（production） | Runtime のイメージの push → 企業ごとの Terraform の適用 |

AWS には GitHub OIDC で接続する（長期のアクセスキーは使わない）。AWS 側の準備と GitHub Environment の変数は [infra/README.md](infra/README.md)。
設定が済むまで、デプロイのワークフローは「未設定のためスキップ」で終わる。

## ドキュメント

- [要件定義書](docs/requirements.md)
- [デプロイ契約（名前・環境変数・IAM）](docs/architecture/deployment-contract.md)
- [API 一覧](docs/architecture/api.md)
- [実装状況と残っている作業](docs/implementation-status.md)
- [OpenAI Agents API（SDK）の調査メモ](docs/reference/openai-agents-sdk.md)
