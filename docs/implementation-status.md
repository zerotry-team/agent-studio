# 実装状況（2026-09-20 時点）

要件定義書（docs/requirements.md）の §15 のフェーズごとに、実装したもの・確認したこと・残っていることをまとめる。
「確認済み」は、ローカルでは Docker の PostgreSQL と擬似 OpenAI を使った自動テスト・画面操作まで。
AWS は production の Control Plane と Sample A 社 Runtime の Terraform 適用、ECS の安定化、Control Plane の `/health` まで確認済み。
以下の従来フェーズ表は初期基盤の記録として残し、Agent版Vercel MVPの最新状態は次節を正とする。

## Agent版Vercel MVP（2026-09-20）

- Agent Projectを中心に、業務説明、必要なConnection/Variables、Preview、同一BuildのProduction昇格、Rollback、Health、Buildログ、Scheduleを一続きにした。AV-030、AV-043、AV-050、AV-051まで実装済み。
- 実OpenAI Session、ローカルの実Session Worker、Tool Gateway、Browser MCPでE2Eを実施した。
- 実画面でSocial Router（5操作）とBrowserを追加し、Preview/Production Connection、SNS投稿Agent、Preview Build、Production Deploymentを作成した。
- 分析Run `cdca2066-9305-4b24-abee-1e99e8c633b3` は、取得不能な外部データを推測せず、投稿案まで生成した。
- 投稿境界Run `e25d54ad-9420-4dbd-a0b7-1055a9e3c476` はApproval `82e1fcb9-c732-40e9-816b-6748f74c8916` で停止し、承認後に1回だけSocial Routerを呼んだ。内部用`logical_post_id`をbodyへ残したためHTTP 400となり、SNS投稿はない。このpayload不具合は修正済みだが、明示確認前のため再実投稿していない。
- Preview Deployment `f63d805f-8611-4941-a9b0-8aad637da7de` とProduction Deployment `3a6e3a9e-f677-443f-8ec0-0f0ce7d2d14e` は同じBuild `df669335-f921-4bd3-9ffd-2ee659ad9194` を参照する。
- 実投稿は対象アカウントと最終本文の明示確認後に限る。現在の対象アカウントはSocial Router側で再認証が必要で、作成したConnection用API Keyも読み取り専用・短期有効である。

今回追加済み:

- Connectionの期限自動検知、revoke、実接続テスト、ローテーションUI。Social Router Previewの実接続確認も成功。
- Agent Projectから設定するSchedule triggerとWorkerによるRun生成。
- Social Router Job IDの構造化保存、自動`get_job`追跡、Runタイムラインとの相関。不明時も自動再投稿しない。
- Tool失敗時の`completed_with_errors` Outcome、警告表示、Health集計。
- Computer / Browser Runtime Phase 1とNetwork/Securityの主要部。RunごとのBrowser Session Task、Private IPの動的Session Grant、Tool Gatewayの動的routing、Screenshot/Snapshot/Browser Action、公開Web向け制限付きコード実行、Orphan Sweeperを実装。
- Browser専用Egress Proxyを追加し、FQDN allowlist、IP literal、private/link-local/metadata系address拒否を強制。`proxy` modeではBrowser TaskのSecurity Groupから直接Internet向け80/443を削除した。
- `browser-automation` Connectorを1能力として扱い、Build時に内部Action群へ展開。`authenticated_restricted`では`browser_exec_js`をContract、Gateway、Workerの3箇所で無効化した。
- 新しいBrowser Worker + Egress ProxyをDocker上で接続し、Proxy経由で`https://example.com`を開き、画像応答とSnapshot内容を確認した。AWS上の実OpenAI E2E、Browser Profile/Human Login、Upload/Download、Computer Actionは未確認・未実装。

残件:

- Providerへの定期Health check（手動の実接続確認は実装済み）。
- Project SettingsのInstructions、Permissions、Environment選択画面。
- Deployment単位のAPI Key、Webhook trigger、利用制限の管理UI。

## 決めたこと（要件定義書 §16 の推奨をすべて採用）

| # | 決定 | 実装 |
|---|---|---|
| D-1 | 認証は Cognito | API は ID トークンを検証（`aws-jwt-verify`）。Web は Hosted UI の認可コードフロー（PKCE） |
| D-2 | RDS for PostgreSQL 16 | `infra/modules/control-plane/rds.tf` |
| D-3 | 署名済み GetCallerIdentity + 短期トークン + long-poll | `backend/api/src/infrastructure/aws/sts-identity.ts`、`runtime/controller` |
| D-4 | Tool Gateway | `runtime/tool-gateway`（Controller と同じタスクの別コンテナ） |
| D-5 | 企業ごとの OpenAI Project | 組織ごとにアプリキー・環境キー・Project ID を保存（Secrets Manager） |
| D-6 | DNS Firewall + セキュリティグループ | `infra/modules/tenant-runtime/dns_firewall.tf` |
| D-8 | Runtime の認証情報は顧客の Secrets Manager | Agent Studio は参照名だけ持つ |
| D-9 | 日本語 → Manifest は OpenAI | Responses APIの構造化出力、Provider Interface、サーバー側の安全なフォールバック |
| D-10 | Workflow は自前 | Worker が `workflow_runs.steps` を進める |
| D-15 | 顧客 AWS 向けは Terraform 先行 | CloudFormation は未作成 |

## OpenAI Agents API の仕様から決まった設計

SDK（`openai` 7.x）の型を調べた結果（docs/reference/openai-agents-sdk.md）:

- **承認の仕組みが API にない** → Agent Studio が実行するツールは、承認されるまで function call の結果を返さない。Runtime のツールは Tool Gateway が「承認待ち」を返し、承認後に Agent Studio が「同じ内容で再実行してください」と伝える（承認は引数のハッシュに紐づき、1回だけ使える）
- **webhook がなく、イベントの再送もない** → Worker がセッションを作り、そのままイベントのストリームを持つ。切れたら `sessions.retrieve` で状態を合わせる
- **self_hosted の環境は `workspace_directory` だけ**（パッケージなどは指定できない）→ 必要なものは Session Worker のイメージに入れる
- `openai` 7.x は Node.js 22 以上が必要

## フェーズごとの状況

### Phase 0 技術検証 — ローカル実Runtimeは完了、AWS上の再検証が残る
本物のOpenAIとローカルの実Session Worker / Tool Gateway / Browser MCPはAgent版Vercel MVPで確認済み。AWS上では要件定義書 §4.3 のうち次が残る。
- P-1 Fargate 上の `codex exec-server` の再検証（イメージは作成済み）
- P-2 環境キーを API で発行できるか（現在は画面から手で登録する前提）
- P-4 Executor の再接続（`environment_connection` の要求に対して Worker の起動をやり直す実装は入れてある）

### Phase 1 Core — 実装済み
- 組織・メンバー・ロール、Cognito / 開発用の認証、組織ごとの OpenAI 設定
- Agent Manifest（検証・バージョン・公開）、日本語からの生成、Compiler
- Tool Registry（Agent Studio 実行 / 公開 MCP / Runtime のツール）、接続先（値は保存しない）
- OpenAI の環境での実行、実行履歴・タイムライン・使用量
- RLS・複合外部キー・監査ログ（追記のみ）— 結合テストで確認済み

### Phase 2 実行環境の抽象化 — 実装済み
- 実行環境（なし / OpenAI / 企業の AWS）、デプロイ（コンパイル結果の保存・置き換え・アーカイブ）、staging / production
- Workflow（Agent のステップと承認のステップを直列に）

### Phase 3 Self-host Runtime — 実装済み（AWS 基盤にデプロイ済み、実接続は未確認）
- Runtime の登録（Bootstrap Token + AWS の身元）、短期トークン、ジョブの long-poll、ハートビート、オフラインの判定
- Runtime Controller（Session Worker の起動・停止・監視）、Tool Gateway、Session Worker のイメージ
- `infra/modules/tenant-runtime`、`infra/company/sample-a-company`
- 登録・承認・後片付けの流れは結合テストで確認済み（Runtime 側は API を直接呼んで確認）

### Phase 4 マルチテナントの強化 — 一部
- 済: Runtime の失効、環境キーの配り直し（ジョブ）、運営管理者フラグの保護、Terraform の state の暗号化、監査ログの S3 Object Lock への書き出し（1時間ごと）
- 残: break-glass、イメージの署名、SSO（SAML）、ペネトレーションテスト

### Phase 5 MCP / Browser — 実装済み（AWS 上は未確認）
- Tool Gateway の HTTP ツール・上流の MCP（Browser Worker）、ポリシー、承認、監査
- 外部の内容を読むツールがあるときの暗黙の承認（POL-07）
- 残: 承認依頼のメール・Slack 通知（画面のみ）、SAP など実システムのコネクタ（HTTP ツールとして設定する前提）

### Phase 6 自動プロビジョニング — 一部
- 済: テナントの追加は `infra/company/<slug>/` を作るだけで CI/CD が適用する
- 済: `infra/organization` で AWS Organizations 配下のアカウントを Terraform から作成、`infra/bootstrap` で state / GitHub OIDC / ECR / GitHub Environment を初期設定
- 残: 画面からのアカウント作成・構築と進捗表示、パターン B 向けの CloudFormation

### Phase 7 以降 — 一部
- 済: Eval（テストケース・実行・判定）、月ごとの利用量、実行の成果物（`/workspace/outputs`）の S3 への保存と画面からのダウンロード
- 残: 料金計算、運用ダッシュボード

## 確認できていること

| 対象 | 方法 | 結果 |
|---|---|---|
| 型・単体テスト | `yarn type-check` / `yarn test`（全ワークスペース） | 型検査成功、250 件すべて成功 |
| 組織の分離・実行の流れ | `yarn workspace @agent-studio/api test:integration`（PostgreSQL） | 24 件すべて成功 |
| ビルド | `yarn build`、`docker build`（api / web / runtime の全イメージ） | 成功 |
| Terraform | `fmt` / `validate`（5 つのルートモジュール）、モックのプロバイダーでの apply | 成功 |
| ワークフロー | actionlint | 指摘なし |
| Runtime の実プロセス | 手元で API + Controller + Tool Gateway + 社内 API モックを動かし、MCP クライアントで呼び出し | 登録・ハートビート・ツールの絞り込み・Runtime 側の拒否・承認待ち → 承認 → 1 回だけ実行 → 監査ログ まで確認 |
| 画面 | 開発用ログインでダッシュボード・実行の詳細を表示 | 表示できる |
| AWS production 基盤 | GitHub Actions で Control Plane / Sample A 社 Runtime を適用し、ECS の安定化と公開 URL の `/health` を確認 | 基盤は成功。本物の OpenAI / Claude と Runtime セッションの E2E は未確認 |

## 気づいている改善点

- 実行の詳細の「実行した人」が利用者 ID で表示される（メールアドレスの表示にする）
- 承認依頼の通知がない（画面のみ）
- API の `/runs/:id/events` はポーリング（2 秒ごと）。多数の利用者が同時に見る場合は SSE などを検討する

## 本番に出す前に必要な作業

1. production の `as-production/anthropic-api-key` と、組織ごとの OpenAI Project ID / アプリキー / 環境キーを設定する
2. Runtime の Bootstrap Token と production の組織 ID・接続先を合わせ、Runtime 登録から Session Worker 接続まで確認する
3. Phase 0 の技術検証（特に Fargate 上の `codex exec-server`、環境キーの発行）
4. 顧客への説明: OpenAI に送られるデータの範囲、米国での処理、ZDR 非対応（要件定義書 §4.2-A / SEC-21）
