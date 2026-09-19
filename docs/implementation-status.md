# 実装状況（2026-09-19 時点）

要件定義書（docs/requirements.md）の §15 のフェーズごとに、実装したもの・確認したこと・残っていることをまとめる。
「確認済み」はローカル（Docker の PostgreSQL と擬似 OpenAI）での自動テストや動作確認まで。AWS 上での動作と、本物の OpenAI Agents API との接続は未確認。

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
| D-9 | 日本語 → Manifest は Claude | `claude-opus-5`、構造化出力、サーバー側のフォールバック |
| D-10 | Workflow は自前 | Worker が `workflow_runs.steps` を進める |
| D-15 | 顧客 AWS 向けは Terraform 先行 | CloudFormation は未作成 |

## OpenAI Agents API の仕様から決まった設計

SDK（`openai` 7.x）の型を調べた結果（docs/reference/openai-agents-sdk.md）:

- **承認の仕組みが API にない** → Agent Studio が実行するツールは、承認されるまで function call の結果を返さない。Runtime のツールは Tool Gateway が「承認待ち」を返し、承認後に Agent Studio が「同じ内容で再実行してください」と伝える（承認は引数のハッシュに紐づき、1回だけ使える）
- **webhook がなく、イベントの再送もない** → Worker がセッションを作り、そのままイベントのストリームを持つ。切れたら `sessions.retrieve` で状態を合わせる
- **self_hosted の環境は `workspace_directory` だけ**（パッケージなどは指定できない）→ 必要なものは Session Worker のイメージに入れる
- `openai` 7.x は Node.js 22 以上が必要

## フェーズごとの状況

### Phase 0 技術検証 — 未実施
AWS と本物の OpenAI を使った検証は未実施。要件定義書 §4.3 の P-1〜P-10 が残っている。特に:
- P-1 Fargate 上の `codex exec-server` の接続（イメージは作成済み）
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

### Phase 3 Self-host Runtime — 実装済み（AWS 上は未確認）
- Runtime の登録（Bootstrap Token + AWS の身元）、短期トークン、ジョブの long-poll、ハートビート、オフラインの判定
- Runtime Controller（Session Worker の起動・停止・監視）、Tool Gateway、Session Worker のイメージ
- `infra/modules/tenant-runtime`、`infra/company/sample-a-company`
- 登録・承認・後片付けの流れは結合テストで確認済み（Runtime 側は API を直接呼んで確認）

### Phase 4 マルチテナントの強化 — 一部
- 済: Runtime の失効、環境キーの配り直し（ジョブ）、運営管理者フラグの保護、Terraform の state の暗号化
- 残: 監査ログの S3 Object Lock への書き出し（バケットは Terraform で作成済み、書き出す処理は未実装）、break-glass、イメージの署名、SSO（SAML）、ペネトレーションテスト

### Phase 5 MCP / Browser — 実装済み（AWS 上は未確認）
- Tool Gateway の HTTP ツール・上流の MCP（Browser Worker）、ポリシー、承認、監査
- 外部の内容を読むツールがあるときの暗黙の承認（POL-07）
- 残: 承認依頼のメール・Slack 通知（画面のみ）、SAP など実システムのコネクタ（HTTP ツールとして設定する前提）

### Phase 6 自動プロビジョニング — 一部
- 済: テナントの追加は `infra/company/<slug>/` を作るだけで CI/CD が適用する
- 残: AWS アカウントの自動作成、パターン B 向けの CloudFormation、画面からの構築と進捗表示

### Phase 7 以降 — 一部
- 済: Eval（テストケース・実行・判定）、月ごとの利用量
- 残: 料金計算、運用ダッシュボード、実行の成果物（`/workspace/outputs`）の S3 への保存

## 本番に出す前に必要な作業

1. AWS アカウントの用意と `infra/bootstrap` の適用、GitHub Environment の変数（infra/README.md）
2. Phase 0 の技術検証（特に Fargate 上の `codex exec-server`、環境キーの発行）
3. `infra/company/sample-a-company/config.yaml` の組織 ID・接続先 URL を本物にする
4. 顧客への説明: OpenAI に送られるデータの範囲、米国での処理、ZDR 非対応（要件定義書 §4.2-A / SEC-21）
