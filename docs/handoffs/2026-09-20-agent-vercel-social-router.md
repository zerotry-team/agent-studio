# Agent版Vercel / Social Router 実装共有

更新日: 2026-09-20
担当範囲: このセッションで実装・検証したAgent Project、Connector / Connection、Preview / Production、Run Outcome、Social Router、Schedule
正本: `docs/tool-integrations-social-router-implementation-plan.md`

## 1. この文書の目的

別セッションが、今回の設計判断、実装範囲、検証済み事実、未完了境界を再調査せずに引き継ぐための共有資料である。

同じコミットには、並行セッションが実装したBrowser Session Worker、Egress Proxy、Terraform、CI関連の差分も含まれる。本書はそれらの詳細説明を行わず、このセッションの担当範囲だけを記録する。

## 2. 完成した利用者体験

North Starは「Agent版Vercel」。通常利用者にTool、MCP、HTTP、Runtime、Vaultを意識させず、次の導線を実装した。

1. 実現したい業務を自然言語で説明する。
2. Capability Resolverが必要な連携サービスとVariablesを特定する。
3. 利用者は不足しているConnectionとVariablesだけを設定する。
4. Immutable BuildからPreview Agentを作成する。
5. Preview Chat / APIで検証する。
6. 同じBuildを再生成せずProductionへPromoteする。
7. Run、操作、承認、外部Job、エラーを時系列で追跡する。
8. 必要なら過去のProduction BuildへRollbackする。

Toolは内部では引き続き1アクション単位であり、Risk、Policy、Approval、Audit、Connection権限の境界を維持している。

## 3. 主な実装

### 3.1 Agent Project / Build / Deployment

- `POST /agent-projects`で業務説明からAgent Projectを作成する。
- Capability ResolverがConnector単位で必要能力を解決する。
- Preview / ProductionごとにConnectionとVariablesを分離する。
- BuildにはAgent Version、Tool Version、Policy、Environment、Variablesを固定する。
- PreviewからProductionへのPromoteは同じ`build_id`を参照する。
- 過去Production DeploymentへのRollbackに対応した。
- 通常画面ではAgent Projectを中心にOverview / Preview / Deployments / Runs / Settingsを表示する。
- 従来のTool編集画面はAdvancedとして残した。

主要ファイル:

- `backend/api/src/domain/capability-resolver.ts`
- `backend/api/src/application/agents.ts`
- `backend/api/src/application/environments.ts`
- `frontend/web/src/app/(dashboard)/agents/[id]/page.tsx`
- `frontend/web/src/components/agents/agent-creator.tsx`
- `prisma/migrations/20260920090000_agent_projects_connectors/migration.sql`

### 3.2 Connector / Connection

- Connectorを通常利用者が理解する「連携サービス」として表示する。
- Social Routerは5操作を1サービスとして追加する。
- PreviewとProductionで別Connectionを選択できる。
- Connection Secretはwrite-onlyで、APIレスポンス、Manifest、Compiled Config、ログへ値を返さない。
- Connectionに`connected / expired / revoked / error`を実装した。
- 有効期限の自動検知、明示失効、実接続確認、認証情報ローテーションUIを実装した。
- 実接続確認には、Connector内の引数不要・読み取り専用GET操作を1回だけ使用する。
- SSRF対策としてHTTPSと公開IPだけを許可する。
- Social Router Preview Connectionの実接続確認は実画面から成功済み。

主要ファイル:

- `backend/api/src/application/tools.ts`
- `backend/api/src/infrastructure/http/public-url.ts`
- `frontend/web/src/app/(dashboard)/integrations/page.tsx`
- `frontend/web/src/components/connections/set-connection-secret-dialog.tsx`
- `prisma/migrations/20260920153000_run_outcome_connection_lifecycle/migration.sql`

### 3.3 Social Router投稿境界とIdempotency

Social Router Connectorの操作:

- `list_accounts`
- `list_posts`
- `get_post`
- `publish_post`
- `get_job`

`publish_post`の`logical_post_id`はAgent Studio内部の論理IDであり、Social RouterのJSON bodyには送らない。実行基盤が`run_id + tool_name + logical_post_id`からSHA-256のIdempotency-Keyを生成してHTTPヘッダへ設定する。

外部送信操作はPolicyにより承認待ちになる。承認後の接続先エラーは「承認要求がなかった」ではなく「承認後の実行に失敗した」とTool結果へ返す。共通Agent指示にもこの区別を追加した。

主要ファイル:

- `backend/api/src/worker/studio-functions.ts`
- `backend/api/src/worker/run-driver.ts`
- `backend/api/src/domain/manifest-compiler.ts`
- `packages/contracts/src/tools.ts`

### 3.4 Run Outcome

Runの処理状態`status`とは別に、結果`outcome`を追加した。

- `pending`
- `succeeded`
- `completed_with_errors`
- `failed`
- `cancelled`

Agentが最終回答を返してRun自体が`completed`でも、Tool実行に失敗した場合は`completed_with_errors`になる。画面では「完了（操作エラーあり）」と警告表示し、Production Healthの失敗率にも反映する。

既存RunはMigrationでRun Eventを参照してbackfillする。履歴のAgent回答本文は監査証跡として改変しない。

### 3.5 Social Router外部Job追跡

- `publish_post`成功レスポンスから`id / job_id / jobId`を取得して`external_jobs`へ保存する。
- Run、Connector、Provider Job IDを関連付ける。
- Workerは`get_job`だけを実行して状態を追跡する。
- `pending / processing / succeeded / failed / unknown`をRun Timelineへ表示する。
- 20回確認しても確定しない場合は`unknown`とし、自動再投稿しない。
- `failed / unknown`はRun Outcomeを`completed_with_errors`へ更新する。
- 終了済みRunでもExternal Jobが処理中なら、Run画面は結果確定までポーリングを続ける。

主要ファイル:

- `backend/api/src/worker/external-jobs.ts`
- `backend/api/src/worker/scheduler.ts`
- `frontend/web/src/components/runs/run-event-timeline.tsx`
- `frontend/web/src/components/runs/use-run-stream.ts`

### 3.6 Schedule

Agent Project Settingsから次を設定できる。

- 名前
- Preview / Production
- 曜日
- 日本時間の実行時刻
- 毎回の指示
- 有効 / 停止

WorkerはSecurity Definer関数で期限到来Scheduleを排他的にclaimし、ReadyなDeploymentだけをRunとして作成する。DeploymentがReadyでなければ実行せず、監査ログへ記録して次回へ送る。

MVPのTimezoneは`Asia/Tokyo`固定。

主要ファイル:

- `backend/api/src/application/schedules.ts`
- `frontend/web/src/actions/schedules.ts`
- `frontend/web/src/lib/repositories/schedule.repository.ts`
- `prisma/migrations/20260920161000_agent_schedules/migration.sql`

## 4. DB Migration順

今回追加したMigrationは次の順で適用する。

1. `20260920090000_agent_projects_connectors`
2. `20260920093000_group_existing_sample_tools`
3. `20260920153000_run_outcome_connection_lifecycle`
4. `20260920161000_agent_schedules`

適用コマンド:

```bash
yarn prisma:migrate:deploy
yarn prisma:generate
```

RLS対象テーブルにはTenant Policyを設定し、Workerの組織横断claim処理は最小限のSecurity Definer関数へ閉じ込めている。

## 5. 自動テストとBuild

2026-09-20の最終確認結果:

```text
yarn type-check
  成功

yarn test
  250 tests passed（同一コミットに統合されたBrowser Runtime / Egress Proxyのテストを含む）

yarn workspace @agent-studio/api test:integration
  24 tests passed

yarn build
  成功
```

追加した主なテスト:

- Capability Resolver
- Idempotency-Keyと内部引数除去
- External Jobレスポンス正規化
- Schedule次回日時計算
- Agent Project作成、Connection / Variables設定、Preview Build
- 同一BuildのProduction Promote、Rollback
- Schedule作成、停止、一覧
- Tenant Isolation

注意: ローカル開発Workerを動かしたままIntegration Testを実行すると、WorkerがテストRunをclaimする。Integration Test前に開発Workerを停止し、終了後に再起動すること。

注意: `yarn build`後は開発中のNext.js `.next`と競合する場合があるため、`yarn dev:web`を再起動すること。

## 6. 実OpenAI / Runtime / Browserで確認した証跡

作成済みAgent Project:

- Agent: `SNS投稿分析・作成エージェント`
- Agent ID: `8c5196e1-ac79-4172-9e7a-61bf80dc372d`
- Preview Deployment: `f63d805f-8611-4941-a9b0-8aad637da7de`
- Production Deployment: `3a6e3a9e-f677-443f-8ec0-0f0ce7d2d14e`
- 両Deploymentが参照するBuild: `df669335-f921-4bd3-9ffd-2ee659ad9194`

分析Run:

- Run ID: `cdca2066-9305-4b24-abee-1e99e8c633b3`
- Browser分析とSocial Router読み取りを試行した。
- 取得不能な外部情報を推測で補わず、取得状況を明示して投稿案を生成した。

承認境界Run:

- Run ID: `e25d54ad-9420-4dbd-a0b7-1055a9e3c476`
- Approval ID: `82e1fcb9-c732-40e9-816b-6748f74c8916`
- 14:11:33に承認待ちで停止した。
- 14:55:49に承認された。
- 14:55:52に`publish_post`を1回だけ実行した。
- 当時は内部用`logical_post_id`がbodyに残る不具合によりHTTP 400となった。
- SNS投稿成功はなく、再試行もしていない。
- 現在はMigration backfillにより「完了（操作エラーあり）」と表示される。
- Timelineには承認依頼、承認、Tool失敗が正しく残る。
- payload不具合は修正済みだが、明示確認前なので修正版での実投稿は行っていない。

実画面確認:

- Agent SettingsにConnection、Variables、Schedule、Advanced Manifestが表示される。
- IntegrationsにSocial RouterのPreview / Production Connectionが表示される。
- Social Router Previewで「接続を確認」を実行し、成功通知を確認した。
- 履歴Runに「完了（操作エラーあり）」と警告が表示される。

## 7. セキュリティと禁止境界

- Secret値をDB、Manifest、Compiled Config、Run Event、Audit detailへ保存しない。
- Connection Secretの読み出しAPIを作らない。
- Connector URLはHTTPSかつ公開IPだけを許可する。
- Agentが任意のConnection IDを指定することを許可しない。
- Agent + Stageにリンクされ、Capabilityが許可されたConnectionだけを実行時に使う。
- 外部送信はApprovalを消費してから実行する。
- External Job結果が不明でも自動再投稿しない。
- 実SNS投稿は、対象アカウントと最終本文について利用者の明示確認を得るまで実行しない。

## 8. 未完了・次セッションの候補

優先度順:

1. 対象アカウントと最終本文の明示確認後、修正版`publish_post`を1回だけ実行する。
2. Social Router Jobが`succeeded`になったことと、実SNS側の投稿を両方確認する。
3. 【完了】Provider定期Health check、Connection状態とProduction Healthへの伝播、外部Triggerのfail-closed。
4. 【完了】Project SettingsのInstructions編集、CapabilityごとのPermissions UI、Environment選択。
5. 【完了】Deployment単位API Key、Webhook Trigger、Rate Limit管理UI。
6. ScheduleのTimezoneを`Asia/Tokyo`以外へ拡張する。

## 9. 引き継ぎ時の開始点

1. `docs/tool-integrations-social-router-implementation-plan.md`を正本として読む。
2. 本書で今回の実装差分と証跡を確認する。
3. `yarn prisma:migrate:status`、`yarn type-check`、対象テストを実行する。
4. 実投稿を扱う場合は、対象アカウントIDをSocial Routerの`list_accounts`で再確認する。
5. 最終本文を利用者へ提示し、明示確認を得る。
6. `publish_post`は同じ論理投稿IDで1回だけ実行する。
7. Run Timeline、External Job、実SNSの3箇所で結果を確認する。
