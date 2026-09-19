# Company Runtime（Execution Plane）

顧客（企業）ごとの AWS アカウントで動く、Agent Studio の実行環境です。
Agent Studio（Control Plane）とは **Runtime から Agent Studio へのアウトバウンド HTTPS だけ** でつながります（CRT-07）。

設計の前提は次を参照してください。

- `docs/architecture/deployment-contract.md` §5（環境変数・ポート・IAM・シークレット・SG）
- `docs/requirements.md` §5.3（内部構成）、§8.1（登録）、§8.2（Self-hosted の実行）、§9（セキュリティ）
- `packages/contracts/src/runtime-protocol.ts`（Runtime API のパスと型）、`runtime-config.ts`（ツール設定）

## 構成

```text
┌──────────── runtime-core タスク（タスクロール <prefix>-runtime を共有）────────────┐
│ controller（Runtime Controller）            tool-gateway（Tool Gateway）          │
│  ・Agent Studio に登録・短期トークン取得     ・0.0.0.0:8080 /mcp（MCP, stateless）  │
│  ・ジョブの long-poll → Worker の起動・停止  ・トークン検証 → 許可されたツールだけ  │
│  ・ハートビート / Worker の監視              ・ポリシー・承認・監査               │
│  ・127.0.0.1:8081 内部 API ◀───────────────  ・認証情報を Secrets Manager から注入  │
│                                              ・127.0.0.1:8082 カタログ            │
└────────────────────────────────────────────────────────────────────────────────┘
        │ ecs:RunTask                                  ▲ MCP（セッション用トークン）
        ▼                                              │
  session-worker（セッションごとの Fargate タスク）─────┘
   codex exec-server --remote … --environment-id …    ── WSS ──▶ OpenAI
   ※ 業務システムの認証情報・AWS の権限を持たない（環境キーだけ）

  tool-gateway ──▶ demo-internal-api（:8090）/ 社内 API（HTTP ツール）
               └─▶ browser-worker（:8931, Playwright MCP）（配下の MCP サーバー）
```

| ディレクトリ | パッケージ / イメージ | 役割 |
|---|---|---|
| `controller/` | `@agent-studio/runtime-controller` / `agent-studio/runtime-controller` | 登録（Bootstrap Token + 署名済み GetCallerIdentity）、ジョブの取得、Session Worker の起動・停止・監視、ハートビート、Tool Gateway 向けの内部 API（セッションの許可情報・承認の中継・監査の送信） |
| `tool-gateway/` | `@agent-studio/tool-gateway` / `agent-studio/tool-gateway` | Session Worker 向けの MCP エンドポイント。セッション用トークンの検証、許可されたツールの判定、ポリシー（拒否・承認・回数・時間帯）、承認待ち、監査、認証情報の注入、HTTP ツールと配下の MCP サーバーへの中継 |
| `session-worker/` | `agent-studio/session-worker`（Dockerfile のみ） | `codex exec-server`。セッションごとに 1 タスク、使い捨て |
| `browser-worker/` | `agent-studio/browser-worker`（Dockerfile のみ） | Playwright MCP（HTTP）。Tool Gateway の配下で動く |
| `demo-internal-api/` | `@agent-studio/demo-internal-api` / `agent-studio/demo-internal-api` | 受け入れシナリオ用の社内 API モック（商品と価格） |

## Runtime Controller

### 動き

1. 起動すると `POST /runtime/v1/token` に署名済み GetCallerIdentity を送ってアクセストークン（15 分）を得る。期限の約 2 分前に取り直し、401 のときは一度だけ取り直して再試行する。
2. `403 runtime_not_registered` なら、Bootstrap Token（`BOOTSTRAP_TOKEN_SECRET_ID`）で `POST /runtime/v1/register` する。成功したら環境キーを `ENVIRONMENT_KEY_SECRET_ID` に保存し、Bootstrap Token のシークレットを `consumed` に書き換える。値が無い・`unset`・`consumed` のときは 60 秒ごとに待つ。
3. `403 runtime_revoked` ならジョブの取得を止め、Tool Gateway へのセッションの提供も止めて、5 分ごとに再確認する。
4. 認証後、`GET /runtime/v1/sessions/active` と実行中のタスク（`ListTasks(startedBy="as/<session_id>")`）を突き合わせて引き継ぐ。
5. `GET /runtime/v1/jobs/next?wait=20` を繰り返す（ジョブは並行して処理する）。
   - `start_session`: 同時実行数を確認 → `RunTask`（FARGATE・awsvpc・パブリック IP なし・タグ `agentstudio:session_id` / `agentstudio:run_id`）→ `worker_starting` → RUNNING で `worker_running`（ジョブ成功）。5 分以内に RUNNING にならない・先に STOPPED になったら `worker_failed`（ジョブ失敗）。
   - `stop_session`: `StopTask` → 許可情報を消す → `worker_stopped`。何度呼んでも成功する。
   - `rotate_environment_key`: `GET /runtime/v1/environment-key` → Secrets Manager に保存。
6. 30 秒ごとにハートビート（バージョン、`GATEWAY_PUBLIC_URL`、実行中のセッション、Tool Gateway のカタログ）。15 秒ごとに Worker を監視し、終了を報告（終了コード 0・Controller が止めたものは `worker_stopped`、それ以外は `worker_failed`）、最大寿命を過ぎたものを停止する。
7. SIGTERM ではジョブの取得をやめ、処理中のジョブを最大 20 秒待って終了する。**実行中の Session Worker は止めない**。

### 内部 API（127.0.0.1:`CONTROLLER_INTERNAL_PORT` だけに bind）

| メソッド・パス | 内容 |
|---|---|
| `GET /internal/sessions/by-token-hash/:hash` | SessionGrant（無い・期限切れは 404）。手元に無ければ activeSessions を取り直す（10 秒に 1 回まで） |
| `POST /internal/approvals` | 承認依頼を Agent Studio に中継 |
| `GET /internal/approvals/:id` | 承認の状態 |
| `POST /internal/approvals/:id/consume` | 承認の消費（1 回だけ） |
| `POST /internal/audit` | 監査イベント（`{events}`）。5 秒ごとに 500 件ずつ Agent Studio に送る |
| `GET /internal/health` | 状態 |

### 環境変数

| 変数 | 既定 | 内容 |
|---|---|---|
| `AGENT_STUDIO_URL` | （必須） | Agent Studio の公開 URL |
| `RUNTIME_SERVER_ID` | （必須） | Agent Studio 側の値と一致させる（署名対象のヘッダ `x-agent-studio-server-id`） |
| `AWS_REGION` | `ap-northeast-1` | |
| `BOOTSTRAP_TOKEN_SECRET_ID` / `ENVIRONMENT_KEY_SECRET_ID` | （secrets-manager のとき必須） | Secrets Manager のシークレット |
| `ECS_CLUSTER` / `SESSION_WORKER_TASK_DEFINITION` / `SESSION_WORKER_SUBNETS` / `SESSION_WORKER_SECURITY_GROUPS` | （ecs のとき必須） | サブネット・SG はカンマ区切り |
| `SESSION_WORKER_CONTAINER_NAME` | `session-worker` | |
| `GATEWAY_PUBLIC_URL` | （必須） | Session Worker から見た MCP の URL（ハートビートで報告） |
| `GATEWAY_CATALOG_URL` | `http://127.0.0.1:8082/internal/catalog` | |
| `CONTROLLER_INTERNAL_PORT` | `8081` | |
| `MAX_CONCURRENT_SESSIONS` / `SESSION_MAX_LIFETIME_MINUTES` / `SESSION_IDLE_TIMEOUT_MINUTES` | `10` / `120` / `30` | 最大寿命はジョブの値とこの値の小さい方 |
| `LOG_LEVEL` | `info` | |
| **ローカル開発用** | | |
| `RUNTIME_IDENTITY_MODE` | `aws` | `dev` にすると身元証明が `dev://<DEV_AWS_ACCOUNT_ID>/<DEV_ROLE_NAME>` になる（`NODE_ENV=production` では使えない。Agent Studio 側も `RUNTIME_IDENTITY_MODE=dev` が必要） |
| `DEV_AWS_ACCOUNT_ID` / `DEV_ROLE_NAME` | | dev のとき必須 |
| `BOOTSTRAP_TOKEN` | | シークレットの代わりに Bootstrap Token を渡す |
| `ENVIRONMENT_KEY_STORE` | `secrets-manager` | `memory` にすると Secrets Manager を使わない |
| `SESSION_LAUNCHER` | `ecs` | `docker`（`docker run --rm -d` で手元に Worker を起動）/ `noop`（起動したものとして扱う） |
| `SESSION_WORKER_IMAGE` / `SESSION_WORKER_DOCKER_NETWORK` | | docker のときのイメージ・ネットワーク |

## Tool Gateway

### 動き

- `POST /mcp`（MCP Streamable HTTP、**stateless**: リクエストごとにサーバーとトランスポートを作る）。`GET` / `DELETE /mcp` は 405、本文は 1MB まで、CORS なし。`GET /health`。
- すべての `/mcp` で `Authorization: Bearer <セッション用トークン>` を検証する。SHA-256 にして Controller に問い合わせ、結果を 30 秒（見つからないときは 5 秒）キャッシュする。無効なら HTTP 401（JSON-RPC エラー）。
- 見せるツールは **SessionGrant の allowed_tools ∩ カタログ** だけ。カタログは設定の HTTP ツールと、配下の MCP サーバーのツールのうち許可リストにあるもの（5 分ごとに取り直す。`expose_as` で名前を付け替える）。
- `tools/call`:
  1. セッションで許可され、カタログにあるツールか
  2. ポリシー = SessionGrant のポリシー + ツール（または配下のサーバー）のポリシー + 設定全体のポリシー。`evaluatePolicies` で最も厳しい結果にする（回数はセッション × ツールごとにメモリで数える）
  3. 拒否 → 理由を `isError` で返す
  4. 承認が必要 → Controller 経由で承認依頼（同じセッション・同じ引数なら Agent Studio は既存の依頼を返す）。`APPROVAL_WAIT_SECONDS` まで 2 秒ごとに確認し、承認されたら **消費してから** 実行する。待ち切れなければ「承認ID」を伝えて終わる（承認後に同じ内容で再実行してもらう）
  5. 実行し、監査イベント（`executed` / `failed`、所要時間）を送る
- 監査イベントは引数そのものを含めない（`args_hash` だけ）。送信はツールの結果を待たせない。
- HTTP ツール: URL の `{param}` は `encodeURIComponent` して埋め込み（接続先のホスト部分には使えない）、GET / DELETE は残りの引数をクエリ文字列、POST / PUT / PATCH は JSON 本文にする。認証情報は `${CONNECTION_SECRETS_PREFIX}<secret>` から取得（5 分キャッシュ）。応答は 100KB まで、2xx 以外は `isError`。リダイレクトは追わない（認証情報を別のホストに送らないため）。
- 配下の MCP サーバー: Agent のセッション × サーバーごとに 1 本の MCP 接続を使う（ブラウザの状態をセッションごとに分ける）。30 分使われない接続と、許可の期限が切れた接続は閉じる。

### 環境変数

| 変数 | 既定 | 内容 |
|---|---|---|
| `PORT` | `8080` | 公開リスナー（`HOST` 既定 `0.0.0.0`） |
| `INTERNAL_PORT` | `8082` | カタログ（127.0.0.1 だけ） |
| `TOOL_CONFIG_PARAMETER` | | SSM パラメータ名（JSON または YAML）。本番はこちら |
| `TOOL_CONFIG_PATH` | | ローカルのファイル（`TOOL_CONFIG_PARAMETER` が無いとき） |
| `CONNECTION_SECRETS_SOURCE` | `secrets-manager` | `env` にすると `CONNECTION_SECRET_<名前を大文字・_にしたもの>` を読む（ローカル開発用。`NODE_ENV=production` では使えない） |
| `CONNECTION_SECRETS_PREFIX` | （secrets-manager のとき必須） | 例: `agent-studio/runtime/sample-a/prod/connections/` |
| `CONTROLLER_INTERNAL_URL` | `http://127.0.0.1:8081` | |
| `APPROVAL_WAIT_SECONDS` | `25` | 承認を待つ最大秒数（0〜55） |
| `APPROVAL_POLL_INTERVAL_MS` | `2000` | |
| `UPSTREAM_REFRESH_SECONDS` / `UPSTREAM_IDLE_MINUTES` | `300` / `30` | |
| `AWS_REGION` | `ap-northeast-1` | |

ツール設定の例: [`tool-gateway/examples/tool-config.local.yaml`](tool-gateway/examples/tool-config.local.yaml)。設定が読めない・正しくないときは起動しない。

## Session Worker

`codex exec-server --remote "$REMOTE_URL" --environment-id "$ENVIRONMENT_ID"` を実行するだけのイメージです（`@openai/codex` **0.155.1** に固定）。

- `REMOTE_URL` / `ENVIRONMENT_ID` は Controller が RunTask の containerOverrides で、`CODEX_API_KEY`（環境キー）はタスク定義の `secrets` で渡す。どれかが無ければ終了コード 64 で終わる。キーはログに出さない。
- uid 10001 の一般ユーザー、`HOME=/home/worker`、作業ディレクトリ `/workspace`。git・python3・ripgrep・curl を入れている。
- `codex` を上げるときは `codex exec-server --help` で `--remote` と `--environment-id` があることを確認してから `CODEX_VERSION` を変える。

## Browser Worker

[`browser-worker/README.md`](browser-worker/README.md) を参照（`@playwright/mcp` **0.0.80** + `mcr.microsoft.com/playwright:v1.63.0-noble`）。

## 社内 API モック（demo-internal-api）

`Authorization: Bearer ${DEMO_API_TOKEN}` が必要（`/health` を除く）。`NODE_ENV=production` で `DEMO_API_TOKEN` が無い・`unset` なら起動しない。ローカルで未設定のときは `local-demo-token` を使う。

| メソッド・パス | 内容 |
|---|---|
| `GET /products` | 商品の一覧 |
| `GET /products/:id` | 商品（`P-001`〜`P-005`） |
| `POST /products/:id/price` | `{ "price_change": 数値 }` だけ価格を変える（0 円未満にはしない）。`{ product_id, before, after }` を返す |
| `GET /health` | |

## ローカルで動かす

前提: Docker、Node 22、`yarn install` 済み、Agent Studio の API がローカル（`http://localhost:3200`）で `RUNTIME_IDENTITY_MODE=dev` で動いていること（API の `RUNTIME_SERVER_ID` の既定は `agent-studio-local`）。

1. Agent Studio で Runtime を用意し、Bootstrap Token を発行する。シードではアカウント ID `111111111111`、ロール名 `as-sample-a-dev-runtime` の Runtime が作られる。

2. パッケージをビルドし、Session Worker のイメージを作る。

   ```bash
   yarn workspace @agent-studio/contracts build
   docker build --platform linux/amd64 -f runtime/session-worker/Dockerfile -t agent-studio/session-worker:local .
   ```

3. 社内 API モック（ターミナル 1）

   ```bash
   DEMO_API_TOKEN=local-demo-token yarn workspace @agent-studio/demo-internal-api dev
   ```

4. Tool Gateway（ターミナル 2）。パスは `runtime/tool-gateway` からの相対パス。

   ```bash
   TOOL_CONFIG_PATH=examples/tool-config.local.yaml \
   CONNECTION_SECRETS_SOURCE=env \
   CONNECTION_SECRET_DEMO_INTERNAL_API=local-demo-token \
   yarn workspace @agent-studio/tool-gateway dev
   ```

5. Runtime Controller（ターミナル 3）

   ```bash
   AGENT_STUDIO_URL=http://localhost:3200 \
   RUNTIME_SERVER_ID=agent-studio-local \
   RUNTIME_IDENTITY_MODE=dev DEV_AWS_ACCOUNT_ID=111111111111 DEV_ROLE_NAME=as-sample-a-dev-runtime \
   BOOTSTRAP_TOKEN=<手順 1 のトークン> \
   ENVIRONMENT_KEY_STORE=memory \
   SESSION_LAUNCHER=docker SESSION_WORKER_IMAGE=agent-studio/session-worker:local \
   GATEWAY_PUBLIC_URL=http://host.docker.internal:8080/mcp \
   yarn workspace @agent-studio/runtime-controller dev
   ```

   - 登録後は Bootstrap Token が無くても `token` で認証できる（dev の身元で Runtime を特定するため）。
   - `ENVIRONMENT_KEY_STORE=memory` で再起動した場合、docker の Worker を起動するときに環境キーを Agent Studio（`/runtime/v1/environment-key`）から取り直す。
   - Worker を起動せずに Controller と Tool Gateway だけを試すときは `SESSION_LAUNCHER=noop`。
   - Agent Studio 側が `AGENTS_API_MODE=fake` のときは `remote_url` が実在しないため、docker の Worker は接続できずに終了する（`worker_failed` になる）。

6. 動作確認

   ```bash
   curl -s localhost:8081/internal/health        # Controller（auth_state が active になる）
   curl -s localhost:8082/internal/catalog       # Tool Gateway のカタログ
   ```

   Session Worker の代わりに MCP クライアント（`@modelcontextprotocol/sdk`）で `http://localhost:8080/mcp` に `Authorization: Bearer <セッション用トークン>` を付けて `tools/list` / `tools/call` を呼べる。

## テスト・ビルド

```bash
yarn workspace @agent-studio/runtime-controller type-check && yarn workspace @agent-studio/runtime-controller test && yarn workspace @agent-studio/runtime-controller build
yarn workspace @agent-studio/tool-gateway type-check && yarn workspace @agent-studio/tool-gateway test && yarn workspace @agent-studio/tool-gateway build
yarn workspace @agent-studio/demo-internal-api type-check && yarn workspace @agent-studio/demo-internal-api test && yarn workspace @agent-studio/demo-internal-api build
```

## イメージのビルド

すべてリポジトリのルートをビルドコンテキストにし、`linux/amd64`（Fargate X86_64）でビルドする。

```bash
docker build --platform linux/amd64 -f runtime/controller/Dockerfile        -t agent-studio/runtime-controller .
docker build --platform linux/amd64 -f runtime/tool-gateway/Dockerfile      -t agent-studio/tool-gateway .
docker build --platform linux/amd64 -f runtime/demo-internal-api/Dockerfile -t agent-studio/demo-internal-api .
docker build --platform linux/amd64 -f runtime/session-worker/Dockerfile    -t agent-studio/session-worker .
docker build --platform linux/amd64 -f runtime/browser-worker/Dockerfile    -t agent-studio/browser-worker .
```

Node のサービス（controller / tool-gateway / demo-internal-api）は、ワークスペースの `package.json` だけを先に集めて依存を入れ、`yarn workspaces focus --production` で実行に要る依存だけにしてから、一般ユーザー（`node`）で `node dist/index.js` を動かす。

## セキュリティ上の注意

- トークン（アクセストークン・セッション用トークン・Bootstrap Token）と鍵（環境キー・業務システムの認証情報）はログに出さない。pino の redact も設定しているが、ログに渡す値に含めないことを前提にする。
- Controller の内部 API と Tool Gateway のカタログは 127.0.0.1 にだけ bind する。同じタスクのコンテナ（controller と tool-gateway）だけが使える。Session Worker は別タスクなので届かない。
- Session Worker に渡すのは環境キーだけ。業務システムの認証情報は Tool Gateway が保持・注入する（SEC-12 / SEC-13）。
