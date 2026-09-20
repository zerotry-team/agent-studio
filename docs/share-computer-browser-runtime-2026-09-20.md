# Computer / Browser Runtime 実装共有（2026-09-20）

## 目的

Agent StudioのRunごとに隔離されたChromiumを起動し、AgentがMCP Tool経由でWebを閲覧・操作できるBrowser Runtimeを追加した。公開Web向けの一時セッションを先に実装し、認証済みブラウザでは任意コード実行を禁止する契約まで用意している。

本資料は、このセッションで実装したComputer / Browser Runtime関連の変更だけを共有する。ほかのセッションで進めたAgent Project、Connector、Schedule、Social Router等の実装内容は含めない。

## 実装した範囲

### 1. Runtime Contract

- `public_ephemeral`と`authenticated_restricted`のBrowser modeを追加した。
- Browser Sessionのviewport、許可ドメイン、Profile ID、コード実行可否、Computer Action可否をStart Sessionへ追加した。
- Controllerが起動後に解決したBrowser endpointをSession Grantへ追加した。
- `authenticated_restricted`では`profile_id`を必須とし、`browser_exec_js`を有効化できないSchema検証を追加した。
- Runtime MCP upstreamに、Session Grantから接続先を解決する`dynamic_session_endpoint: browser`を追加した。

主なファイル:

- `packages/contracts/src/runtime-protocol.ts`
- `packages/contracts/src/runtime-config.ts`
- `backend/api/src/worker/run-driver.ts`

### 2. Browser Session Worker

`runtime/browser-session-worker`を新設した。Playwright/Chromiumを1 Runごとに1 BrowserContextで保持し、次のMCP Toolを提供する。

- `browser_navigate`
- `browser_snapshot`
- `browser_screenshot`
- `browser_wait_for`
- `browser_tabs`
- `browser_click`
- `browser_type`
- `browser_press_key`
- `browser_select_option`
- `browser_hover`
- `browser_drag`
- `browser_exec_js`

操作系Toolは操作後のScreenshotを返す。ScreenshotはMCP responseとして返し、Workerのログには出力しない。WorkerはRun固有tokenを含む`/mcp/<token>`だけを受け付け、SIGTERM時にBrowserContextとChromiumを閉じる。

URL Policyでは次を拒否する。

- `http`/`https`以外
- allowlist外のFQDN
- IP literal
- localhost
- link-local、private、multicast、metadata address

`browser_exec_js`は`public_ephemeral`だけで公開し、タイムアウトと出力上限を設定した。`authenticated_restricted`ではTool catalogから除外する。

主なファイル:

- `runtime/browser-session-worker/src/actions.ts`
- `runtime/browser-session-worker/src/session.ts`
- `runtime/browser-session-worker/src/policy.ts`
- `runtime/browser-session-worker/src/code-runtime.ts`
- `runtime/browser-session-worker/Dockerfile`

### 3. Controller Lifecycle

Runtime ControllerへECS/Docker/Noop/Disabled Browser Launcherを追加した。

Start Session時の順序は次のとおり。

1. Browser TaskをRun単位で起動する。
2. RUNNINGとPrivate IPの確定を待つ。
3. Run固有token付きendpointをSession Grantへ設定する。
4. Session Workerを起動する。

Session Workerの起動失敗、Run停止、最大寿命超過、Browser Task異常終了時には両Taskを停止する。Controller再起動時はECS Taskを再検出し、Browser endpointを再構築する。起動時のOrphan SweeperでGrantに存在しないBrowser Taskも停止する。

主なファイル:

- `runtime/controller/src/browser-launcher.ts`
- `runtime/controller/src/jobs.ts`
- `runtime/controller/src/monitor.ts`
- `runtime/controller/src/controller.ts`
- `runtime/controller/src/grants.ts`

### 4. Tool Gateway

- Browser Workerがまだ存在しないHeartbeat時点でも、設定ファイルからBrowser Tool catalogを構築できるようにした。
- Tool呼び出し時にはSession GrantのBrowser endpointへ接続する。
- Browser GrantがないRunにはBrowser Toolを公開しない。
- `authenticated_restricted`では`browser_exec_js`を公開しない。
- 既存のTool risk、policy、approval、audit経路をそのまま適用する。
- 未信頼コンテンツを読んだ後のBrowser書き込み操作は既存POL-07により承認対象となる。

主なファイル:

- `runtime/tool-gateway/src/catalog.ts`
- `runtime/tool-gateway/src/tool-call.ts`
- `runtime/tool-gateway/src/upstream.ts`

### 5. Network / Egress Security

`runtime/egress-proxy`を新設した。Browser TaskのInternet出口をこのProxyに限定し、次を実施する。

- 許可FQDNだけを転送する。
- IP literalを拒否する。
- DNS解決結果にprivate/link-local/multicast/mapped-private addressが含まれる場合は拒否する。
- 接続先portを80/443に限定する。
- URL path、header、bodyをログに残さず、method、origin、status、durationだけを記録する。
- ChromiumのQUICを無効化し、HTTP Proxyを必ず通す。

TerraformではBrowser Taskからの直接80/443 egressを削除し、Browser Security GroupからEgress Proxyの3128番だけを許可した。Egress Proxy側だけが80/443へ接続できる。

主なファイル:

- `runtime/egress-proxy/src/index.ts`
- `runtime/egress-proxy/src/policy.ts`
- `infra/modules/tenant-runtime/security_groups.tf`
- `infra/modules/tenant-runtime/ecs.tf`

### 6. ECS / Terraform / CI

- Runごとに起動するBrowser ECS Task Definitionを追加した。常駐Browser Serviceは作成しない。
- Browser Taskはprivate subnet、public IPなし、read-only root filesystem、non-root、Linux capabilities全drop、AWS権限なしで実行する。
- 常駐Egress Proxy Service、Cloud Map、CloudWatch Logs、Security Groupを追加した。
- Browser WorkerとEgress Proxy用ECR repositoryを追加した。
- CIとRuntime deploy workflowで両Docker imageをbuild/pushするようにした。
- sample staging/productionへ`browser_runtime`と`egress_policy`を設定した。
- `egress_policy.mode = proxy`を標準とし、移行用に`legacy_direct`を残した。`network_firewall`は未実装として明示的に拒否する。

主なファイル:

- `infra/bootstrap/ecr.tf`
- `infra/modules/tenant-runtime/variables.tf`
- `infra/modules/tenant-runtime/ecs.tf`
- `infra/modules/tenant-runtime/iam.tf`
- `infra/modules/tenant-runtime/security_groups.tf`
- `.github/workflows/ci.yml`
- `.github/workflows/deploy-runtime.yml`

### 7. Agent Studio UI / Capability

- Integrations画面へ「ブラウザ操作」Connector presetを追加した。
- Agent要件がBrowser Toolのいずれかを要求した場合、Capability Resolverが同じConnectorのBrowser Tool一式をBuild時に展開するようにした。
- ユーザーが内部Browser Actionを1つずつ選ぶ必要はない。

主なファイル:

- `frontend/web/src/app/(dashboard)/integrations/page.tsx`
- `backend/api/src/domain/capability-resolver.ts`

## 設定値

Controller側のBrowser launcher設定、Browser Task Definition、Security Group、subnetはRuntime環境変数から取得する。Browser TaskにはControllerが次をRunTask overrideで渡す。

- `BROWSER_SESSION_TOKEN`
- `BROWSER_MODE`
- `BROWSER_ALLOWED_DOMAINS`
- `BROWSER_CODE_EXECUTION_ENABLED`
- `BROWSER_COMPUTER_ACTIONS_ENABLED`
- `BROWSER_VIEWPORT_WIDTH`
- `BROWSER_VIEWPORT_HEIGHT`

Egress ProxyにはTerraformから`ALLOWED_DOMAINS`を渡す。Browser WorkerにはProxy mode時だけ`BROWSER_PROXY_SERVER`を設定する。

## 検証結果

2026-09-20に次を実施し、成功した。

- `yarn type-check`
- `yarn test`（250 tests passed）
- `yarn build`
- `terraform fmt -check -recursive infra`
- sample stagingの`terraform init -backend=false`と`terraform validate`
- Browser Worker Docker image build
- Egress Proxy Docker image build
- Docker network上でEgress ProxyとBrowser Workerを起動する実通信Smoke Test
- MCP clientから11 Toolの取得
- `browser_navigate`で`https://example.com`へ接続
- Screenshot responseと`Example Domain`を含むSnapshotの確認
- allowlist外ドメイン、direct IP、private address拒否のUnit Test

## 実装計画との対応

完了:

- Phase 1 `CBR-001`〜`CBR-010`
- Phase 2 `CBR-011`〜`CBR-015`、`CBR-018`
- Phase 3 `CBR-026`
- Phase 4 `CBR-027`〜`CBR-029`、`CBR-032`
- Phase 6 `CBR-040`

未完了:

- `CBR-016`: Upload/Downloadの保存先、サイズ上限、成果物化
- `CBR-017`: 完了。Control Plane API、Runtime Controller、Tool Gatewayの構造化ログと例外文字列へ共通redactionを適用し、Secret/Cookie/Header/Screenshot Base64/JWT/URL queryを実ログテストで検証
- `CBR-019`〜`CBR-025`: Browser Profile、暗号化Store、Human Login Relay/UI
- `CBR-030`〜`CBR-031`: Connection/許可ドメイン確認とRun画面のBrowser状態表示
- `CBR-033`〜`CBR-038`: Computer Adapterと座標ベース操作
- `CBR-039`、`CBR-041`〜`CBR-046`: 分離性、Prompt Injection、二重投稿、秘密値、AWS実環境E2E、負荷試験

詳細なチェックリストは`docs/computer-browser-runtime-implementation-spec.md`を参照する。

## 運用上の注意

- この時点で完了しているのはコード実装とローカル検証までで、AWSへのTerraform apply、Runtime deployment、本番E2Eは実施していない。
- `authenticated_restricted`の契約と任意コード禁止は実装済みだが、Browser Profile本体とHuman Loginは未実装である。
- Browser Workerは自動的な書き込み再試行を行わない。Task消失後の再実行による二重投稿防止はAWS E2Eで追加確認が必要である。
- allowlistはBrowser WorkerとEgress Proxyの両方で検査する。実環境では業務に必要なFQDNだけをTerraformへ設定する。
- `legacy_direct`は移行用であり、本番標準は`proxy`とする。
