# Agent Studio 最終完成仕様書 v1.0

更新日: 2026-09-22

## 0. この文書の目的

この文書は、Agent Studioを「自然言語でやりたいことを伝えると、必要な能力を調査・準備・実装・検証し、実際に使えるAgentをProductionまで完成させる製品」にするための、残実装を一つにまとめた実行仕様書である。

別セッションは、本書を単なる調査や設計の依頼として扱わず、既存実装を再利用しながら、実装、テスト、実ブラウザ確認、Preview Run、Production Run、運用確認まで継続すること。

「コードを書いた」「PRを作った」「画面にReadyと出た」は完了ではない。代表入力で必要なToolが実際に呼ばれ、業務結果が検証され、同じBuildがProductionで成功し、Health・Audit・Rollbackまで確認できたときだけ完成とする。

---

## 1. 最終的なプロダクト像

利用者が行う基本操作は次の2つだけとする。

1. 作りたいAgentを自然言語で説明する
2. 人間にしかできない操作が発生したときだけ、OAuth同意、ログイン、Secret登録、クラウド管理者承認、外部送信承認を行う

それ以外はBuilder Agentが自律的に行う。

- 依頼と完了条件の構造化
- OpenAIモデル標準能力で実行可能かの判定
- Web Search、画像理解、OCR、画像生成、Computer Use等の既存能力の選択
- Tool Catalog、Connection、Runtime能力の調査
- Connectionは存在するが未接続の場合の設定導線
- 公開OpenAPI / MCPからの宣言的Connector生成
- 汎用Provider用AdapterのAgent Studio本体への追加
- 企業固有システム用Adapterの企業専用Integration Repositoryへの追加
- GitHub repository作成、default branch設定、専用branch、PR、CI、merge
- package build、scan、SBOM、署名、Runtime配布、Tool再登録
- Agent、Workflow、Policy、Immutable Buildの生成
- Preview Run、Eval、自動修正、再実行
- 同一BuildのProduction昇格
- 限定Production Run、Health、Audit、Rollback確認

利用者にOpenAPI、MCP、Tool入出力、Repository名、branch名、生成先、モデル名を最初から選ばせない。Builderが調査して決定し、本当に人間の判断が必要な場合だけ、業務用語で一件ずつ確認する。

---

## 2. 現在の基準点

### 2.1 Git基準点

- Repository: `zerotry-team/agent-studio`
- 基準branch: `main`
- 基準commit: `e7724552a14e447da76e1396d3920a1271438c76`
- PR: `#4 fix(builder): finish production validation reliably`
- PR #4のCI: 型チェック、単体テスト、build、DB migration/schema/RLS/integration、各コンテナbuildが成功

開始時に必ず`git status --short --branch`、`git log -5 --oneline --decorate`、open PR、関連worktreeを確認する。基準commitより新しい変更がある場合は、差分を捨てずに本書との対応を整理する。

### 2.2 既に実証できた縦切り

Agent `b31082bd-71da-4905-a003-ea70e0732b67`について、次を実ブラウザと実Runで確認済み。

- 自然言語の社内DB読み取り依頼
- 企業専用Integration Repositoryへのbranch / PR / merge
- 署名付きAdapter packageのPreview配布
- Runtime heartbeatによるTool登録
- Preview Run成功
- 同一BuildのProduction昇格
- Production Run `a8c75a3f-a856-4e05-85b0-0e8c9c257dba`
- `lookup_contract` Tool Call成功
- `TEST-CONTRACT-001`に対して契約状況`active`、更新日`2026-09-22`を取得
- `outcome=succeeded`、`used_expected_tool=true`、drift validation成功
- Builder画面で`Production Ready / Preview Ready / 100% / production_succeeded`

ただし、これはローカルRuntimeと読み取り専用fixtureによる一例であり、Agent Studio全体の完成証明ではない。

### 2.3 作業中ファイルの保護

2026-09-22時点で、次の未コミット変更が存在する。別セッションまたは利用者の作業として扱い、勝手に削除、上書き、stash、reset、checkoutしない。

- `backend/api/src/worker/builder-orchestrator.ts`
- `backend/api/src/worker/logic.test.ts`
- `frontend/web/src/components/layout/sidebar-nav.tsx`
- `frontend/web/src/lib/utils/permissions.ts`
- `docs/demo/`
- `docs/zenn/`
- `frontend/web/src/app/(dashboard)/factoring-demo/`
- `frontend/web/src/components/factoring-demo/`

重なる変更が必要なら、まず意図と差分を読み、既存変更を含めて安全に統合する。別worktreeを使う場合も、最終的に本来の作業内容を取りこぼさない。

---

## 3. 完成判定

Agent Studio完成は、次の4段階をすべて満たすことを意味する。

### 3.1 Builder Core完成

- 自然言語から完了条件と代表入力を作る
- 必要能力をモデル標準機能、既存Tool、未設定Connection、公開API/MCP、Browser、Custom Codeに正しく分類する
- 不足能力だけを準備する
- 失敗原因を構造化し、安全な範囲で修正・再テストする
- 待機中と失敗を区別する
- 再起動やworker停止後も同じJobを再開する

### 3.2 Agent完成

- Agent、Workflow、Tool、Connection参照、Policy、Runtime Config、Immutable Buildが固定される
- 代表入力のPreview Runが`completed / succeeded`
- 必須Tool Callが`completed`
- 業務結果が期待値と一致する
- 失敗ケース、境界値、権限拒否をEvalで確認する

### 3.3 Production完成

- Previewと同じBuildをProductionへ昇格する
- Production限定Runが成功する
- RuntimeとConnectionがhealthy
- driftがない
- Auditから要件、変更、承認、Tool Call、結果を追跡できる
- Rollbackが実行可能で、直前の正常Buildへ戻せる

### 3.4 製品運用完成

- 実AWS環境へdeploy済み
- migration、API、Web、Worker、Runtime、Tool Gateway、Browser Workerが稼働する
- Providerの定期Health checkと期限切れ検知が動く
- tenant分離、rate limit、usage、API key、webhook、監査保持が動く
- 運用者が障害原因と復旧操作を画面から確認できる

---

## 4. Capability解決の必須判定順

Builderは次の順序で能力を解決する。下位方式を先に選んではならない。

1. **OpenAIモデル標準能力**
   - 推論、文章生成、要約、分類、画像理解、一般的OCR、画像生成
   - Web SearchまたはComputer Useで十分な公開情報取得
   - モデルだけで完了する場合はCustom Toolを作らない
2. **登録済みTool + 接続済みConnection**
   - そのまま利用する
3. **登録済みTool + 未設定Connection**
   - OAuth、API Key、Secret Store、Human Login等の最小Human Actionを提示する
4. **公開OpenAPI / MCP**
   - 仕様を自動Discoveryし、宣言的Connectorで解決する
5. **公開Web Browser Flow**
   - APIがない場合だけ、許可domainを限定して利用する
6. **汎用Providerだが未登録**
   - 例: kintone、Supabase等、多組織で再利用できるProvider
   - Agent Studio共通Adapterとして専用branch / PRを作成する
7. **企業固有システム**
   - 企業専用Integration Repositoryと企業専用RuntimeへAdapterを作る
   - Agent Studio本体へ顧客固有コードを混入させない

判定結果には、選択方式、棄却した方式、必要権限、データ境界、費用、危険度、完了条件を保存する。利用者向け画面では技術用語を隠し、「何ができるようになるか」「人にしかできないこと」「完了後に自動再開すること」を表示する。

---

## 5. 残実装ワークストリーム

## WS-01 現在地の再同期と仕様の正本化

### 実装

- `docs/implementation-status.md`を現在のmainと実証結果へ更新する
- PR #3/#4で完成したGitHub delivery、package、Tool登録、Production検証を未完了一覧から除く
- 要件、実装状況、受け入れ結果の相互リンクを追加する
- DB migrationとAPI contractの現在差分を確認する
- fixture、fake、実Provider、実AWSの証拠を混同しないステータス表を作る

### 完了条件

- どの項目が`implemented`、`tested_fake`、`tested_local_real`、`tested_cloud_real`、`blocked_human`か一目で分かる
- 古い未完了記述が現在の実装と矛盾しない

## WS-02 自律診断・修正・再実行ループ

### 実装

- Builder failureを少なくとも次に分類する
  - `requirements_invalid`
  - `capability_missing`
  - `connection_missing`
  - `permission_missing`
  - `runtime_unavailable`
  - `git_delivery_failed`
  - `package_failed`
  - `tool_registration_failed`
  - `build_failed`
  - `preview_failed`
  - `production_failed`
  - `drift_detected`
  - `policy_denied`
- 各分類に、再試行可否、修正方法、最大attempt、backoff、Human Gateを定義する
- Build、test、Tool Call、業務Eval、Browser evidenceを使って修正案を生成する
- 同じ失敗を無限反復しない。error fingerprint単位でattemptを数える
- 修正できる失敗は専用branchへ追加commitし、再度CIからやり直す
- Human Action完了後は手動再実行ボタンなしで再開する
- Worker lease切れ、process再起動、重複heartbeatでも二重Run、二重PR、二重投稿を作らない
- 成功後に遅れて到着した古いイベントが状態を失敗へ戻さない

### 完了条件

- 意図的に壊したTool schema、test、権限、Runtime heartbeat、Production代表入力について、原因を表示し、修復可能なものは自動修復して成功する
- 同一error fingerprintで上限を超えた場合だけ、具体的な最後のHuman Actionまたは`blocked`へ移る
- DBやコードを開発者が直接手修正しなくても再開できる

## WS-03 モデル標準能力とBuilt-in Toolの統合

### 実装

- モデル標準能力のCatalogを追加する
  - text/reasoning
  - vision/OCR
  - image generation
  - web search
  - computer use
- 依頼から必要能力を推定し、利用可能モデル・組織Policy・費用上限を考慮して選ぶ
- OCRや画像理解のためだけに不要なCustom Backendを生成しない
- 最新ニュースなど時点依存情報はWeb Searchを使い、取得日時と出典を結果へ残す
- 画像生成は入力、出力Artifact、安全判定、費用をRun証跡へ残す
- 画像/PDF等の入力が必要だが未提供なら、必要なファイルだけをHuman Actionとして求める

### 完了条件

- OCR、画像生成、最新ニュース調査の3種類を、不要なCustom Toolなしで自然言語からPreview成功まで作れる
- 出典、Artifact、使用モデル、費用がRunから確認できる

## WS-04 ConnectionとHuman Loginの完成

### 実装

- OAuth開始、callback、token refresh、revoke、scope driftを一貫したConnection状態へ統合する
- API Key / BearerはSecret値をBuilder、Control Plane DB、Git、ログ、モデルへ渡さない
- Browser Profileを組織・Provider・Environment単位で暗号化保存する
- Human Login用の一時Sessionを作り、パスワード、MFA、CAPTCHAは利用者だけが操作する
- ログイン成功を検知してProfileを保存し、待機中Builderを自動再開する
- Profileの期限切れ、revoke、再認証を検知する
- `authenticated_restricted`では任意JavaScript実行を禁止し続ける
- Connection選択をAgent作成フォームから排除し、必要時だけ設定画面へ深いリンクで誘導する

### 完了条件

- 認証が必要な実Providerを1つ接続し、OAuth/Human Login後に同じBuilder Runが自動再開する
- Secret、password、MFA、cookie内容がAPI response、DB平文、ログ、モデル入力へ出ないことをテストする

## WS-05 Browser Upload / Download / Computer Action

### 実装

- DownloadをRun専用領域へ保存し、size、MIME、hash、malware scan、保持期限を記録する
- DownloadをArtifact化し、別Runや別tenantから参照できないようにする
- Uploadは任意local pathではなくArtifact IDだけを受け付ける
- Uploadは`external_send`として宛先、ファイル名、hashを固定し承認を必須にする
- Browserのtab、cookie、download、profileをRun間で分離する
- Computer Actionは許可されたアプリ、window、domain、操作種別だけに限定する
- Screenshot/Snapshotと操作イベントをAuditへ残す
- CAPTCHA、MFA、パスワード入力、安全警告回避を自動化しない

### 完了条件

- 2つの同時Runでcookie、tab、downloadが混ざらない
- Download→Artifact→承認付きUploadのE2Eが成功する
- 認証済みBrowserでComputer Actionを使う代表ケースが成功する

## WS-06 企業専用Runtimeと実インフラ

### 実装

- GitHub App接続時に企業専用private Integration Repositoryを冪等作成する
- default branchを`main`に設定し、branch protection、Required Checks、CODEOWNERS、署名検証を設定する
- repositoryが既にある場合は重複作成せず、安全性と所有組織を確認して再利用する
- 顧客AWS用Terraform planを生成し、管理者承認後にapplyする
- Runtime Controller、Session Worker、Tool Gateway、Browser Worker、Egress Proxy、Secret Storeをdeployする
- bootstrap tokenは一回限り・短時間とし、登録後に破棄する
- 顧客RuntimeのToolは顧客DBへ接続し、Control Planeには最小構造化結果だけを返す
- Runtime heartbeat、version、Tool Catalog、package digest、source commit、署名を照合する
- Runtime upgrade、rollback、orphan cleanupを実装する

### 完了条件

- 新規組織について、repositoryなしの状態からprivate repo作成、main設定、PR、merge、package配布、Tool登録まで成功する
- 実AWS Runtimeから実検証用DBへ読み取りを行い、Raw dataやSecretがControl Planeへ出ない
- Runtime停止・再起動・旧digest heartbeat・署名不一致でfail closedする

## WS-07 汎用Adapterと企業固有Adapterの分離

### 実装

- Capability classifierへ`shared_provider_adapter`と`organization_private_adapter`を追加する
- 汎用AdapterはAgent Studio本体または共通Integration RepositoryへPRを作る
- 企業固有Adapterは企業専用Repository以外へpushしない
- 企業固有domain、schema、identifierが共通Repositoryへ混入しないscanを追加する
- 共通Adapter公開時は互換性、multi-tenant、scope、rate limit、migrationを検査する
- merge後の利用可能化時刻と対象組織を画面へ表示する

### 完了条件

- kintone等の汎用Providerと、A社契約DBの企業固有Providerを正しいRepositoryへ自動振り分ける
- 誤分類テストで本体への顧客固有コード混入を拒否する

## WS-08 複雑WorkflowとファクタリングE2E

### 実装

- F-01〜F-08を決定的なRule / Workflowとして実行する
- 社内履歴DB、否決一覧DB、通帳画像集計、公開または認証済み反社照合を同一Agentへ組み込む
- 金額、閾値、分岐、照合結果はLLMの自由判断にしない
- 可・否・保留のfixtureを作る
- Tool失敗、timeout、不明、矛盾、欠損はfail closedする
- 最終判断は担当者承認へ送る
- 匿名化済み外部投稿は、最終本文と宛先を表示して承認後に1回だけ送る
- Provider Jobが`succeeded`になるまで追跡し、permalinkを保存する
- `unknown`やtimeoutで自動再投稿しない

### 完了条件

- 可・否・保留の全Eval Caseが期待分岐と一致する
- F-01〜F-08の必須Tool Call、Rule結果、承認、外部作用をAuditで追える
- 投稿が1件だけ成功し、Provider成功とpermalinkを確認できる

## WS-09 Production運用機能

### 実装

- Provider定期Health check
- Connection期限・scope drift・revoke監視
- Runtime、Tool、Provider、DeploymentのHealth集約
- Project SettingsのInstructions、Permissions、Environment選択
- Deployment単位API Key
- Webhook triggerと署名検証、replay protection
- schedule trigger
- rate limit、budget、usage cap、concurrency limit
- Production canary、限定Run、rollback
- failed / degraded / completed_with_errorsの通知
- Audit retentionとexport

### 完了条件

- 故障したProvider、期限切れConnection、停止Runtime、driftしたToolを検知してProduction Healthへ反映する
- API KeyとWebhookでProduction Agentを呼び出せる
- rate limitとbudget超過時に安全に拒否する
- rollback後に旧正常Buildの代表Runが成功する

## WS-10 Agent作成UXの最終化

### 実装

- `/agents/new`は自然言語入力を中心にする
- PreviewかProductionかを最初に選ばせない。常にProduction利用可能までを目標にする
- OpenAPI/MCP直接入力は「開発者向け詳細」に隠す
- Tool入出力、Repository、branch、生成先は自動推定し、どうしても決められない業務情報だけ質問する
- 質問は一件ずつ、次を表示する
  - なぜ人間に必要か
  - 何を答えるか
  - Secretや実データを入力しない注意
  - 回答後に自動再開すること
- 「この内容で実装を進める」ではなく、業務内容、読み取り/書き込み、利用先、承認、保存先、検証入力を平易な日本語で要約する
- Vercel型の進行表示を完成させる
  - 現在stage
  - 完了stage
  - 待機理由
  - 実行中/停止中
  - 経過時間
  - 推定残時間または推定不能理由
  - realtime log
  - retry回数
  - PR / CI / package / Runtime / Runへのリンク
- 古い失敗履歴と現在の最終状態を分けて表示する
- `Production Ready`はProduction限定RunとHealth成功後だけ表示する

### 完了条件

- 非技術者がOpenAPI、Tool schema、branch、Runtimeの説明なしで代表Agentを作れる
- 待機中に「いつ終わるか」「何を待っているか」「操作後に自動再開するか」が分かる
- 画面表示とDBの最新releaseが矛盾しない

## WS-11 Cloud deploymentと実運用確認

### 実装

- main merge後のstaging deployを必須checkにする
- staging E2E成功後にproduction deployを行う
- 空のdeploy roleやskipされたjobを成功扱いにしない
- image digest、task definition、migration SHA、Web SHA、API SHAをcommitへ紐づける
- `/health`だけでなくDB、Worker lease、Runtime heartbeat、Tool Gateway、Browser Workerをsynthetic checkする
- production smokeとして、読み取り専用Agentを1回実行する
- deploy失敗時は旧versionを維持し、migration互換性を確認する

### 完了条件

- production URLでCognito認証後にAgent作成からProduction Runまで通る
- 稼働中image/task/health SHAが対象main commitと一致する
- CI greenだがdeploy skippedという状態を成功表示しない

---

## 6. Builder状態モデル

正常系は次の状態を使用する。

```text
requested
  -> analyzing
  -> planning
  -> preparing
  -> implementing
  -> validating
  -> previewing
  -> production_pending_approval
  -> promoting
  -> production_verifying
  -> completed
```

待機系は失敗と分離する。

```text
waiting_connection
waiting_human_login
waiting_secret_registration
waiting_cloud_admin
waiting_external_send_approval
waiting_production_approval
waiting_required_checks
waiting_runtime_heartbeat
```

失敗はstage名だけでなく、`failure_class`、`error_fingerprint`、`retryable`、`attempt`、`next_action`、`last_evidence_id`を保持する。

`completed`へ遷移できるのは、最終Production releaseが`production_succeeded`であり、代表Production Runが`succeeded`、必須Tool Callが成功、業務Evalがpass、driftとHealthがpassの場合だけとする。

---

## 7. Human Gate

### Builderが自動実行してよいもの

- 読み取り専用の調査、Discovery、schema検査
- private workspaceでのコード生成とtest
- 専用branchへのpushとPR作成
- required checks成功後のpolicy許可済みauto-merge
- read-only Preview Run
- retry、rollback候補作成

### 人間に残すもの

- OAuth consent
- Secret登録
- パスワード、MFA、CAPTCHA、規約同意
- 顧客AWSの初回管理者承認
- branch protection例外
- destructiveな変更
- 外部送信・公開・課金・契約変更
- Production昇格承認。ただし組織Policyでread-only Agentの自動昇格を明示許可できる

### 禁止事項

- mainへの直接push
- 未検証コードのProduction配布
- Secret、raw顧客データ、Browser cookie、passwordのControl Plane/Git/log/model保存
- Tool Callなしの回答を業務成功扱いすること
- `completed`だけで`outcome=succeeded`を省略すること
- External Job受付だけで送信成功扱いすること
- MFA/CAPTCHA/安全警告の回避
- 不明状態での自動再投稿、二重更新

---

## 8. 必須E2Eマトリクス

すべてのE2Eで、作成開始から完成まで同じAgent URLを使い、進捗、ログ、証跡を確認する。

| ID | 依頼 | 必須結果 |
|---|---|---|
| E2E-01 | 文章生成・分類 | モデル標準能力だけでPreview/Production成功。不要なToolを生成しない |
| E2E-02 | 画像OCR | Vision/OCRで構造化結果を返し、不要なCustom Backendを作らない |
| E2E-03 | 画像生成 | 画像Artifact、費用、安全判定を保存して成功 |
| E2E-04 | 最新ニュース調査 | Web Searchを使い、取得日時と出典を返す |
| E2E-05 | 接続済みSaaS読み取り | 既存Tool/Connectionを再利用する |
| E2E-06 | 未接続OAuth SaaS | OAuthだけを依頼し、完了後に自動再開する |
| E2E-07 | 公開OpenAPI | 自動Discovery、Tool生成、実Call成功 |
| E2E-08 | 公開MCP | `tools/list`、risk判定、実Call成功 |
| E2E-09 | 公開Web | domain限定Browser Flow、Snapshot付き成功 |
| E2E-10 | ログイン必須Web | Human Login、Profile保存、自動再開、実操作成功 |
| E2E-11 | 企業専用DB | private repo、PR、merge、署名配布、実Runtime、実DB読み取り成功 |
| E2E-12 | 汎用Provider追加 | 共通Repositoryへ追加し、複数組織で利用可能になる |
| E2E-13 | 承認付き書き込み | 承認前は未実行、承認後1回だけ実行、結果確認 |
| E2E-14 | ファクタリング | F-01〜F-08、可/否/保留、承認、匿名投稿、permalink成功 |
| E2E-15 | 自動修復 | 壊れたschema/test/permission/inputを診断・修正して成功 |
| E2E-16 | 障害復旧 | Worker/Runtime再起動後に重複作用なしで再開 |
| E2E-17 | Production rollback | 新Buildをrollbackし、旧Buildの代表Run成功 |

各E2Eの証跡に次を含める。

- Agent ID
- Builder Project / Run / attempt
- capability decision
- Human Actionと完了時刻
- Change Set、branch、commit、PR、merge SHA
- package digest、SBOM digest、signature
- Runtime ID、heartbeat、Tool Version
- Build、Preview Deployment/Run
- Production Deployment/Run
- Tool Call名、引数hash、status
- outcome、業務Eval、Health、drift
- Approval、外部Job、permalink
- screenshotまたはBrowser evidence

---

## 9. テスト要件

### 9.1 常時実行

```bash
yarn type-check
yarn lint
yarn test
yarn build
yarn workspace @agent-studio/api test:integration --run --maxWorkers=1 --minWorkers=1
git diff --check
```

### 9.2 競合防止

- integration test中に通常の`yarn dev:worker`がtest用Jobを取得しないよう、queue/organization/environmentを分離する
- testが実組織のOpenAI key、GitHub App、Runtimeを誤利用しない
- fixture workerとdev workerのclaim条件を契約としてテストする

### 9.3 必須テスト層

- Unit: resolver、risk、state transition、retry、redaction、idempotency
- Contract: OpenAPI、MCP、Runtime protocol、Adapter descriptor、attestation
- Integration: DB/RLS、Builder lease、GitHub delivery、package、heartbeat、Preview/Production
- Security: tenant越境、SSRF、egress、Secret、prompt injection、path traversal、signature mismatch
- Browser: 自然言語作成、Human Action、自動再開、進捗、Preview、Production、Rollback
- Cloud: staging/production deploy、実AWS Runtime、実Provider

テスト失敗を既存不具合として無視しない。今回の変更と無関係なら原因と所有範囲を明示し、completion blockerか判定する。

---

## 10. 実装順序

1. WS-01 現在地同期、未コミット変更の保護、仕様更新
2. WS-02 自律診断・再実行の共通基盤
3. WS-03 モデル標準能力Catalog
4. WS-04 Connection / Human Login
5. WS-05 Browser Upload / Download / Computer Action
6. WS-06 企業専用Runtime / 実AWS
7. WS-07 Adapter分類
8. WS-08 複雑Workflow / ファクタリング
9. WS-09 Production運用
10. WS-10 UX最終化
11. WS-11 Cloud deploy
12. E2E-01〜17、security、load、rollbackを完走
13. docs、runbook、監視、最終証跡を更新

並列化は可能だが、同じファイルを複数セッションで編集する場合はworktreeと所有範囲を明示する。共有DBと通常Workerを使うE2Eは直列化する。

---

## 11. 最終Definition of Done

次のすべてを満たすまで「Agent Studio完成」と報告しない。

- [ ] E2E-01〜17がすべて成功
- [ ] 実企業相当AWS Runtimeと実検証用DBでE2E-11成功
- [ ] Human Login Profileと自動再開が成功
- [ ] Browser Upload / Download / Computer Actionがtenant分離下で成功
- [ ] F-01〜F-08の可・否・保留が成功
- [ ] 承認付き外部作用が1回だけ成功し、Provider結果まで確認
- [ ] 自動修復ケースが開発者のDB/コード手修正なしで成功
- [ ] Previewと同一BuildのProduction限定Run成功
- [ ] Health、drift、Audit、Rollback成功
- [ ] mainの全CI成功
- [ ] stagingとproductionのdeploy成功
- [ ] production稼働SHAが対象main commitと一致
- [ ] Productionブラウザで作成からRun結果まで確認
- [ ] Secret、raw顧客データ、cookie、passwordの漏えいなし
- [ ] 別tenantから全リソースへアクセス不可
- [ ] UIが待機理由、進捗、ETA、ログ、最新結果を正しく表示
- [ ] 実装状況、runbook、既知制約が最新
- [ ] 未コミット変更、未push commit、未merge PRが残っていない

### 完成とみなさない例

- 一例の読み取りAgentだけが成功
- fixture/fakeだけが成功
- PRを作っただけ
- CIがgreenだがdeploy jobがskip
- packageを作ったがRuntime heartbeatで登録未確認
- Runが`completed`だが`outcome`または必須Tool Callが失敗
- Preview成功だがProduction未実行
- Production表示だけで限定Run、Health、driftが未確認
- 外部Job受付だけでProvider成功未確認
- Human Action後に開発者の手動DB更新が必要
- ローカルでは動くがproduction SHA不一致

---

## 12. 別セッションへ貼る実行プロンプト

以下をそのまま別セッションへ渡す。

```text
/Users/iwatashota/Desktop/zerotry-work/other/agent-studio で、
docs/agent-studio-final-completion-spec.md を正本として、Agent Studioの残実装をすべて実装してください。

目標は、自然言語の依頼から能力調査、Connection準備、必要Adapterの実装、GitHub PR/merge、署名package配布、Runtime Tool登録、Agent/Workflow/Build生成、Preview、同一BuildのProduction昇格、限定Production Run、Health、Audit、Rollbackまでを成功させることです。

まずgit status、main、open PR、既存worktree、未コミット変更、現在の実装状況を整理してください。既存の未コミット変更は他セッションまたは利用者の作業なので、削除・reset・checkout・上書きをしないでください。必要なら安全なworktreeとbranchを使い、最終的に全変更を取りこぼさず統合してください。

コードを書いただけ、PRを作っただけ、Previewが表示された、Runがcompletedになっただけでは完了にしないでください。仕様書のE2E-01〜17とDefinition of Doneを満たし、実ブラウザで確認し、CI、staging、production、実Run、Tool Call、業務結果、Health、drift、Audit、Rollbackの証拠を残してください。

OpenAIモデル標準機能でできるOCR、画像理解、画像生成、Web Search等には不要なCustom Toolを作らないでください。既存Tool、未設定Connection、公開OpenAPI/MCP、公開Browser、汎用Provider Adapter、企業固有Adapterの順に正しく分類してください。

OAuth、Secret、MFA、CAPTCHA、顧客AWS管理者操作、外部送信、destructive操作など、人間にしかできない操作だけをHuman Gateにしてください。Human Gateが必要になった場合は、その時点までの実装と検証を終え、理由、対象、必要操作、完了検知方法を具体的に表示してください。操作完了後は自動再開させてください。

進捗中は短い更新を行い、60秒以上無言にしないでください。安全な範囲で失敗を診断・修正・再試行し、成功するまで継続してください。最終報告では、実装、テスト、PR、merge、deploy、Run、未完了の有無を証拠付きで分けてください。仕様書のチェック項目が一つでも未完了なら「完成」と言わないでください。
```

---

## 13. 参照文書

- `docs/builder-agent-requirements.md`
- `docs/builder-agent-completion-task-spec.md`
- `docs/computer-browser-runtime-implementation-spec.md`
- `docs/implementation-status.md`
- `docs/requirements.md`
- `docs/architecture/deployment-contract.md`
- `docs/architecture/api.md`

本書と古い記述が矛盾する場合は、実コード、migration、最新mainのテスト、実ブラウザ/実Run証跡を確認し、本書と`implementation-status.md`を同じ変更で更新する。
