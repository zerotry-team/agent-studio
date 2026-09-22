# デプロイ契約（コンポーネント間の取り決め）

アプリ・Runtime・Terraform・CI/CD がこの文書の名前と値に合わせる。変更するときは関係するすべてを同時に直す。

## 1. 決定事項（要件定義書 §16 の推奨をすべて採用）

| # | 決定 |
|---|---|
| D-1 | 認証は Amazon Cognito（ユーザープール + Hosted UI、TOTP の MFA を任意で有効） |
| D-2 | DB は RDS for PostgreSQL 16 |
| D-3 | Runtime → Agent Studio は「署名済み GetCallerIdentity + 短期トークン + long-poll」 |
| D-4 | Tool Gateway を導入する（Runtime Controller と同じ ECS タスクの別コンテナ） |
| D-5 | OpenAI Project は企業ごと |
| D-6 | Session Worker の通信制限は Route 53 Resolver DNS Firewall + セキュリティグループ |
| D-8 | Runtime 側の認証情報は顧客が自社 AWS の Secrets Manager に直接登録する |
| D-9 | 日本語 → Manifest の生成は OpenAI Responses API |
| D-10 | Workflow は自前（Postgres の状態 + Worker） |
| D-15 | 顧客 AWS 向けは Terraform module を先に提供（CloudFormation は後続） |

## 2. リージョン・命名

- リージョン: `ap-northeast-1`（CloudFront の WAF と証明書だけ `us-east-1`）
- Control Plane の名前の接頭辞: `as-<env>`（env = `staging` / `production`）。例: `as-production-api`
- テナント Runtime の接頭辞: `as-<tenant_short>-<stage_short>`（例: `as-sample-a-prod`）。`tenant_short` は config.yaml の `short_name`、`stage_short` は `prod` / `stg`
- 必須タグ: `agentstudio:component`、`agentstudio:environment`、テナントでは加えて `agentstudio:organization_id`、`agentstudio:runtime_id`

## 3. コンテナイメージ

ECR リポジトリは Agent Studio の各環境アカウント（staging / production）に `infra/bootstrap` で作る。タグは git の commit SHA。

| リポジトリ | ソース | 用途 |
|---|---|---|
| `agent-studio/api` | `backend/api/Dockerfile` | API（`node dist/index.js`）、Worker（`node dist/worker.js`）、マイグレーション（`node dist/scripts/migrate.js`） |
| `agent-studio/web` | `frontend/web/Dockerfile` | Web（Next.js standalone、`node frontend/web/server.js`） |
| `agent-studio/runtime-controller` | `runtime/controller/Dockerfile` | Runtime Controller |
| `agent-studio/tool-gateway` | `runtime/tool-gateway/Dockerfile` | Tool Gateway |
| `agent-studio/session-worker` | `runtime/session-worker/Dockerfile` | `codex exec-server` |
| `agent-studio/browser-worker` | `runtime/browser-worker/Dockerfile` | Playwright MCP |
| `agent-studio/demo-internal-api` | `runtime/demo-internal-api/Dockerfile` | 受け入れシナリオ用の社内 API モック |

Dockerfile はすべてリポジトリのルートをビルドコンテキストにする（`docker build -f <path>/Dockerfile .`）。ベースイメージは `node:22-bookworm-slim`（browser-worker は `mcr.microsoft.com/playwright`）。`linux/amd64`（Fargate X86_64）でビルドする。

`runtime-*` のリポジトリは、テナントのアカウントから pull できるようにリポジトリポリシーで許可する（`aws:PrincipalOrgID` と、組織外の顧客アカウント ID の一覧）。

## 4. Control Plane（`infra/modules/control-plane`）

### 4.1 構成

- VPC（2 AZ、public / private / database サブネット、NAT は staging 1 台・production 2 台）
- ECS クラスター `as-<env>`、Service Connect 名前空間 `as-<env>.local`
- ALB（public サブネット。CloudFront の origin-facing プレフィックスリストからだけ受け付け、ヘッダ `X-Origin-Verify` が一致しない要求は 403）
- CloudFront（既定ドメイン。`domain_name` と証明書を渡した場合は独自ドメイン）+ WAF（AWS マネージドの共通ルール + レート制限）
  - `/api/*`、`/runtime/*`、`/health` → api（キャッシュなし・全ヘッダ転送）
  - それ以外 → web（キャッシュなし）
- RDS for PostgreSQL 16（private、KMS 暗号化、マスターパスワードは RDS 管理の Secrets Manager、PITR）
- S3: `as-<env>-artifacts-<account>`（実行の成果物）、`as-<env>-audit-<account>`（Object Lock・ガバナンスモード 365 日）
- Cognito ユーザープール（メールでサインイン、MFA 任意）+ アプリクライアント（シークレットあり、認可コードフロー、コールバック `https://<公開ドメイン>/auth/callback`、サインアウト `https://<公開ドメイン>/`）+ Hosted UI ドメイン
- KMS キー（Secrets Manager・S3・RDS・ログ用）
- Secrets Manager: `as-<env>/db-app`（アプリ用 DB パスワード、Terraform の random_password）、`as-<env>/runtime-token-secret`（32 バイト以上）、`as-<env>/web-session-secret`、`as-<env>/anthropic-api-key` / `as-<env>/orcarouter-api-key`（値は運用者が設定）、`as-<env>/origin-verify`
- 組織ごとの OpenAI キーはアプリが実行時に `agent-studio/<env>/orgs/<organization_id>/openai-app-key` と `.../openai-env-key` に作る
- SSM パラメータ `/as/<env>/deployed-image-tag`（CI/CD が書く）

### 4.2 ECS サービスとタスク定義

| 名前 | コンテナ | ポート | ヘルスチェック | 備考 |
|---|---|---|---|---|
| `as-<env>-api` | api | 3200 | `GET /health` | Service Connect 名 `api` |
| `as-<env>-worker` | api（command `node dist/worker.js`） | なし | なし | 1 台以上 |
| `as-<env>-web` | web | 3201 | `GET /api/health`（Next.js の Route Handler） | |
| `as-<env>-migrate` | api（command `node dist/scripts/migrate.js`） | なし | なし | サービスなし。CI/CD が run-task する |

画像タグの変数:
- `image_tag`: api / worker / web。`"none"` のときは desired_count を 0 にする（初回デプロイでマイグレーション前にサービスを起動しないため）
- `migrate_image_tag`: migrate タスク定義

### 4.3 API / Worker / Migrate の環境変数

| 変数 | 値 | 種別 |
|---|---|---|
| `NODE_ENV` | `production` | 環境変数 |
| `APP_ENV` | `staging` / `production` | 環境変数 |
| `PORT` | `3200` | 環境変数 |
| `PUBLIC_BASE_URL` | `https://<公開ドメイン>` | 環境変数 |
| `DB_HOST` / `DB_PORT` / `DB_NAME` | RDS のエンドポイント / 5432 / `agent_studio` | 環境変数 |
| `DB_APP_USER` | `agent_studio_app` | 環境変数 |
| `DB_APP_PASSWORD` | `as-<env>/db-app` | シークレット |
| `DB_ADMIN_SECRET` | RDS 管理のマスターシークレット（JSON `{username,password}`）。**migrate タスクだけ** | シークレット |
| `AUTH_MODE` | `cognito` | 環境変数 |
| `COGNITO_USER_POOL_ID` / `COGNITO_CLIENT_ID` | Cognito | 環境変数 |
| `COGNITO_DOMAIN` / `COGNITO_CLI_CLIENT_ID` | CLI（`agent-studio login`）のブラウザログイン用。Hosted UI のドメインと、secret を持たない公開 app client（callback は `http://127.0.0.1:48127/callback`）。API は両方の client ID を aud として受け付ける | 環境変数 |
| `RUNTIME_TOKEN_SECRET` | `as-<env>/runtime-token-secret` | シークレット |
| `RUNTIME_SERVER_ID` | `agent-studio-<env>` | 環境変数 |
| `SECRETS_MODE` | `aws`（ローカルは `file`: `SECRETS_FILE` の JSON に保存。`memory` はテスト専用でプロセス内にしか残らない） | 環境変数 |
| `SECRETS_FILE` | `SECRETS_MODE=file` のときの保存先。既定 `.secrets.local.json`（API と Worker で同じパスにする） | 環境変数 |
| `SECRETS_PREFIX` | `agent-studio/<env>` | 環境変数 |
| `SECRETS_KMS_KEY_ID` | KMS キーの ARN | 環境変数 |
| `ARTIFACTS_BUCKET` / `AUDIT_EXPORT_BUCKET` | S3 バケット名 | 環境変数 |
| `AGENTS_API_MODE` | `openai`（ローカル・CI では `fake` も可） | 環境変数 |
| `OPENAI_DEFAULT_MODEL` | 既定のモデル名 | 環境変数 |
| `ANTHROPIC_API_KEY` | `as-<env>/anthropic-api-key` | シークレット |
| `ORCAROUTER_API_KEY` | `as-<env>/orcarouter-api-key` | 任意の共有シークレット。組織ごとの管理画面設定を優先 |
| `MANIFEST_GENERATOR_MODEL` | OpenAI Responses API のモデル ID | 環境変数 |
| `LOG_LEVEL` | `info` | 環境変数 |
| `OAUTH_CLIENT_ID_<KEY>` / `OAUTH_CLIENT_SECRET_<KEY>` | Provider Catalog の key ごとの OAuth クライアント（例: `OAUTH_CLIENT_ID_SLACK`、`-` は `_`）。任意。組織が画面から登録した OAuth アプリがあればそちらを優先する。`QIITA_OAUTH_CLIENT_ID/SECRET` は後方互換の別名 | Secrets Manager |

### 4.4 Web の環境変数

| 変数 | 値 | 種別 |
|---|---|---|
| `NODE_ENV` / `PORT` / `HOSTNAME` | `production` / `3201` / `0.0.0.0` | 環境変数 |
| `APP_BASE_URL` | `https://<公開ドメイン>` | 環境変数 |
| `API_INTERNAL_URL` | `http://api:3200`（Service Connect） | 環境変数 |
| `AUTH_MODE` | `cognito` | 環境変数 |
| `COGNITO_DOMAIN` | `https://<prefix>.auth.ap-northeast-1.amazoncognito.com` | 環境変数 |
| `COGNITO_CLIENT_ID` | Cognito | 環境変数 |
| `COGNITO_CLIENT_SECRET` | Cognito のクライアントシークレット（Secrets Manager `as-<env>/cognito-client-secret`） | シークレット |
| `SESSION_SECRET` | `as-<env>/web-session-secret` | シークレット |

### 4.5 IAM（タスクロール）

- api / worker: `secretsmanager:CreateSecret/PutSecretValue/GetSecretValue/DescribeSecret/TagResource` を `agent-studio/<env>/orgs/*` に限定、KMS の Encrypt/Decrypt/GenerateDataKey、`cognito-idp:AdminCreateUser/AdminGetUser` をユーザープールに限定、S3 の artifacts / audit バケットへの Put/Get、`sts:GetCallerIdentity` は不要（STS への転送は署名済みリクエストをそのまま送るだけで、Agent Studio 側の認証情報は使わない）
- migrate: タスクロールは権限なし（DB のシークレットは実行ロールが注入）
- web: タスクロールは権限なし

## 5. テナント Runtime（`infra/modules/tenant-runtime`）

### 5.1 構成

- VPC（2 AZ、private サブネットのみにワークロード、public は NAT 用）、NAT（既定 1 台）
- Route 53 Resolver DNS Firewall（許可リスト方式。既定で `api.openai.com`、`codex-cloud-environments.chatgpt.com`、Agent Studio のホスト、`*.amazonaws.com`、`config.yaml` の追加ドメイン。それ以外は BLOCK）
- Cloud Map 私設 DNS 名前空間 `<prefix>.internal`（`gateway`、`browser`、`demo-api`）
- ECS クラスター `<prefix>`
- `runtime-core` サービス（1 タスク = controller コンテナ + tool-gateway コンテナ）。タスクロール名は `<prefix>-runtime`（= Agent Studio に登録する `expected_role_name`）
- Session Worker のタスク定義 `<prefix>-session-worker`（サービスなし。Controller が RunTask する）
- `browser-worker` サービス（`browser_enabled` のとき）
- `demo-internal-api` サービス（`demo_internal_api_enabled` のとき）
- KMS キー、CloudWatch Logs（保持 90 日）
- Secrets Manager:
  - `<secrets_prefix>/bootstrap-token`（値は運用者が `aws secretsmanager put-secret-value` で入れる。Terraform では値を持たない）
  - `<secrets_prefix>/openai-environment-key`（Controller が登録時に書き込む）
  - `<secrets_prefix>/connections/<name>`（業務システムの認証情報。顧客が値を入れる。config.yaml の `connections` から空のシークレットだけ作る）
  - `secrets_prefix` = `agent-studio/runtime/<tenant_short>/<stage_short>`
- SSM パラメータ `/<prefix>/tool-config`（config.yaml の `runtime.tools` を JSON にしたもの。`RuntimeToolConfig` スキーマ。企業専用 Adapter に渡す値は `adapter_runtime`）
- S3 `<prefix>-runtime-artifacts-<account>-<region>`（`adapter_delivery_enabled` のとき。SSE-KMS）: Builder の作業領域 `builder-workspaces/<change_set_id>/{input.tar.gz,result.json,repo.bundle}`（7 日で失効）と、導入済み Adapter `adapters/<connector_key>/{manifest.json,bundle.mjs}`
- `adapter_delivery_enabled` のとき DNS Firewall に `github.com` / `api.github.com` / `objects.githubusercontent.com` / `release-assets.githubusercontent.com` を足す（Controller の clone・push と Release の取得）

### 5.2 セキュリティグループ

| SG | 受信 | 送信 |
|---|---|---|
| runtime-core | 8080 を session-worker SG から | 443 を 0.0.0.0/0、browser / demo-api の SG、`allowed_internal_cidrs` |
| session-worker | なし | 443 を 0.0.0.0/0（DNS Firewall で制限）、8080 を runtime-core SG へ、53（VPC DNS） |
| browser-worker | 8931 を runtime-core SG から | 443 / 80 を 0.0.0.0/0 |
| demo-api | 8090 を runtime-core SG から | なし |

### 5.3 コンテナの環境変数

runtime-core / controller:

| 変数 | 値 |
|---|---|
| `AGENT_STUDIO_URL` | Agent Studio の公開 URL（例: `https://dxxxx.cloudfront.net`） |
| `RUNTIME_SERVER_ID` | `agent-studio-<env>`（Control Plane の値と一致させる） |
| `AWS_REGION` | リージョン |
| `BOOTSTRAP_TOKEN_SECRET_ID` | `<secrets_prefix>/bootstrap-token` |
| `ENVIRONMENT_KEY_SECRET_ID` | `<secrets_prefix>/openai-environment-key` |
| `ECS_CLUSTER` | クラスター ARN |
| `SESSION_WORKER_TASK_DEFINITION` | タスク定義ファミリー名 |
| `SESSION_WORKER_SUBNETS` | カンマ区切り |
| `SESSION_WORKER_SECURITY_GROUPS` | カンマ区切り |
| `SESSION_WORKER_CONTAINER_NAME` | `session-worker` |
| `GATEWAY_PUBLIC_URL` | Session Worker から見た MCP の URL: `http://gateway.<prefix>.internal:8080/mcp` |
| `CONTROLLER_INTERNAL_PORT` | `8081`（127.0.0.1 にだけ bind） |
| `MAX_CONCURRENT_SESSIONS` / `SESSION_MAX_LIFETIME_MINUTES` / `SESSION_IDLE_TIMEOUT_MINUTES` | config.yaml |
| `RUNTIME_ARTIFACT_STORE` | `s3`（`adapter_delivery_enabled`）/ `disabled`。`s3` のときだけ ECS の Builder と Adapter の導入を広告する |
| `RUNTIME_ARTIFACT_BUCKET` / `RUNTIME_ARTIFACT_KMS_KEY_ARN` | 上記 S3 と KMS キー |

runtime-core / tool-gateway:

| 変数 | 値 |
|---|---|
| `PORT` | `8080` |
| `TOOL_CONFIG_PARAMETER` | `/<prefix>/tool-config`（ローカルでは `TOOL_CONFIG_PATH` でファイルも可） |
| `CONNECTION_SECRETS_PREFIX` | `<secrets_prefix>/connections/` |
| `CONTROLLER_INTERNAL_URL` | `http://127.0.0.1:8081` |
| `APPROVAL_WAIT_SECONDS` | `25` |
| `AWS_REGION` | リージョン |

session-worker（Controller が RunTask の containerOverrides で渡す）:

| 変数 | 値 |
|---|---|
| `REMOTE_URL` | OpenAI セッションの `environment.remote_url` |
| `ENVIRONMENT_ID` | `environment.id` |
| `WORKSPACE_DIRECTORY` | `/workspace` |
| `CODEX_API_KEY` | タスク定義の `secrets` で `<secrets_prefix>/openai-environment-key` から注入 |
| `BUILDER_*` | Builder Session のときだけ。対象 Repository・branch・生成先など（資格情報は含まない） |
| `BUILDER_TRANSFER_URL` / `BUILDER_TRANSFER_TOKEN` | ECS の Builder Session のときだけ。`http://gateway.<prefix>.internal:8080/builder-workspaces/<session_id>/<change_set_id>` と Session・Change Set 専用 token。作業領域の受け取り（`GET .../input`）と結果の送信（`PUT .../bundle`、`PUT .../result`）にだけ使える。`codex exec-server` の環境からは外す |

Tool Gateway の公開リスナー（8080）: `/mcp`、`/health`、`/session-outputs/<session_id>/...`、`/builder-workspaces/<session_id>/<change_set_id>/<input|result|bundle>`。
企業専用 Adapter は Tool Gateway のコンテナの中で `node --permission` の子プロセスとして 127.0.0.1:18100 以降で起動し、`adapter_runtime` の値だけを環境変数で受け取る。

### 5.4 IAM

- `<prefix>-runtime`（runtime-core のタスクロール。Controller と Tool Gateway で共有）:
  - `ecs:RunTask`（session-worker のタスク定義に限定）、`ecs:StopTask` / `ecs:DescribeTasks` / `ecs:ListTasks`（クラスターに限定）、`ecs:TagResource`
  - `iam:PassRole`（session-worker のタスクロールと実行ロールに限定）
  - `secretsmanager:GetSecretValue` / `PutSecretValue`（bootstrap-token、openai-environment-key）
  - `secretsmanager:GetSecretValue`（`connections/*`）、`ssm:GetParameter`（tool-config）、KMS Decrypt
  - `adapter_delivery_enabled` のとき: runtime-artifacts バケットの `s3:GetObject` / `PutObject` / `DeleteObject` / `ListBucket` と、S3 経由の KMS
- `<prefix>-session-worker-task`: **ポリシーなし**（SEC-12）
- `<prefix>-session-worker-exec`: ECR pull、ログ、`openai-environment-key` の GetSecretValue

## 6. Runtime API のエンドポイント（Control Plane 側）

`packages/contracts/src/runtime-protocol.ts` の `RUNTIME_API` を正とする。認証は `/runtime/v1/register` と `/runtime/v1/token` 以外すべて `Authorization: Bearer <runtime access token>`（HS256、15 分、`aud=agent-studio-runtime`）。

## 7. ローカル開発

- `docker compose up -d postgres`（ポート 5434）
- `.env`（ルート）: `.env.example` を参照
- API: `http://localhost:3200`、Web: `http://localhost:3201`
- `AUTH_MODE=dev`: `Authorization: Bearer dev:<email>` を受け付ける（`NODE_ENV=production` では起動時にエラーにする）
- `AGENTS_API_MODE=fake`: OpenAI を呼ばずに擬似的なセッションで動かす

## 8. CI/CD（GitHub Actions）

- GitHub Environments: `agent-studio-staging`、`agent-studio-production`、`company-<tenant>-<stage>`
- 各 Environment の変数（vars）: `AWS_REGION`、`AWS_ACCOUNT_ID`、`AWS_DEPLOY_ROLE_ARN`、`TF_STATE_BUCKET`。company 環境は加えて `IMAGE_REGISTRY`（Agent Studio 側 ECR のホスト名）
- 認証は GitHub OIDC → `infra/bootstrap` が作る `as-github-deploy` ロール
- Terraform の state: `s3://<TF_STATE_BUCKET>/<root module のパス>/terraform.tfstate`、`use_lockfile = true`

## 9. 実装で確定した差分・補足（2026-09-19）

実装中に分かったことを反映した。上の各節より、この節を優先する。

| 対象 | 内容 | 理由 |
|---|---|---|
| ECS のコンテナ名 | worker と migrate のコンテナ名も `api`（`run-task --overrides` では `containerName: api`） | 同じイメージ・同じ定義を使うため |
| migrate タスク | api / worker と同じ環境変数・シークレット + `DB_ADMIN_SECRET` | マイグレーションの前にアプリ用ロールのパスワードを合わせるため |
| 運営管理者の作成 | migrate のタスク定義で command を `["node","dist/scripts/grant-platform-admin.js","<email>"]` に上書きして run-task | 最初の1人は画面から作れないため |
| demo-api の SG | 送信 443 を許可（DNS Firewall で制限） | Fargate のイメージ取得・シークレット・ログはタスクのネットワークを通るため |
| `<prefix>-runtime` の KMS | `kms:Decrypt` に加えて `kms:GenerateDataKey`（Secrets Manager 経由のみ） | 環境キーの `PutSecretValue` に必要 |
| DNS Firewall | `*.<prefix>.internal` も許可。VPC 全体が許可リスト方式になるため、Tool Gateway が名前で呼ぶ社内システムや Browser Worker で開くサイトは `extra_allowed_domains` に入れる | |
| tool-gateway の環境変数 | `TOOL_CONFIG_SHA256`（設定が変わったらタスクを入れ替えるため）、`HOST`、`INTERNAL_PORT`（8082、127.0.0.1 のみ） | 設定は起動時にだけ読む |
| browser-worker の環境変数 | `PLAYWRIGHT_MCP_ALLOWED_HOSTS=browser.<prefix>.internal:8931` | Playwright MCP は Host ヘッダを確認する（DNS リバインディング対策） |
| Session Worker の `startedBy` | `as/<session_id>` | ECS の startedBy は英数字・`-` `_` `/` だけ |
| ALB | 80 か 443 のどちらか1つ（`alb_certificate_arn` があれば 443） | CloudFront のプレフィックスリストが SG のルールを多く使うため |
| WAF | `SizeRestrictions_BODY` は記録のみ | Manifest の保存で 8KB を超えるため |
| long-poll | Runtime の long-poll は 25 秒まで | CloudFront のオリジン応答待ちが最大 60 秒のため |
| DB の TLS | RDS は `rds.force_ssl=1`。アプリは RDS の CA（イメージに同梱）で検証する | |
| 仮のシークレット | `anthropic-api-key`、`orcarouter-api-key`、`bootstrap-token`、`openai-environment-key` は値 `unset` で作る | ECS はシークレットの値が無いとタスクを起動できないため |
| config.yaml | `stages.<stage>.organization_id` と `stages.<stage>.runtime` で上書きできる | staging の Agent Studio は DB が別で、組織 ID も別になるため |
| タグ | `agentstudio:runtime_id` は登録前は `unregistered`。`agentstudio:tenant` を追加 | |
