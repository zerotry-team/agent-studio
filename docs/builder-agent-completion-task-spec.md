# Agent Builder 完成タスク仕様書 v0.1

更新日: 2026-09-21

## 0. 位置づけ

本書は、[Agent Studio Builder Agent 要件定義書](builder-agent-requirements.md)を、ファクタリング審査Agentが実Preview成功まで到達するための実装タスクへ分解したものである。

対象は次の6領域とする。

1. Agentと作成作業を一つに見せるUX統合
2. Agents API Sessionと`codex exec-server`によるCode Agent実行
3. Git Provider Appによるbranch pushとPull Request作成
4. merge済みAdapterのConnector / Tool登録とRuntime配布
5. 反社照合、社内DB、通帳画像集計を含む実Preview Run
6. 担当者承認後の匿名化済みX投稿と完了確認

本書の完了は「画面やManifestを作成した」ではなく、非実在データを使った実Preview Runが終端状態まで成功し、すべてのTool Call、承認、外部作用、判断理由を証跡から追跡できることを意味する。

---

## 1. プロダクト上の結論

### 1.1 利用者に見せる中心概念

利用者に見せる中心概念は **Agent** だけとする。

| 概念 | 利用者への表示 | 役割 |
|---|---|---|
| Agent | 表示する | 継続して設定、Preview、Production、実行、改善を行う単位 |
| Builder Agent | 必要な場面だけ説明文に表示 | Agentを作成・修正するシステム側の実行主体 |
| Builder Project | 独立したメニューでは表示しない | 再開可能な作成作業を保持する内部リソース |
| Builder Run / Step | Agentの「作成状況」「作成履歴」に表示 | 要件整理、実装、テスト、Previewの進捗 |
| Immutable Build | AgentのBuildとして表示 | Previewで検証しProductionへ昇格する固定成果物 |
| Deployment | 表示する | PreviewまたはProductionで稼働するBuild |

現在の`builder_projects`は削除しない。Agent作成中の長時間処理、Human Action、再試行、証跡を保存する内部作業単位として維持する。

### 1.2 目標UX

```text
Agents
  └ 新しいAgent
       └ 業務を自然言語で入力
            └ Agent詳細（作成中）
                 ├ 概要
                 ├ 作成状況
                 ├ Preview
                 ├ Deployments
                 ├ Runs
                 └ Settings
```

- サイドバーの「作成プロジェクト」は廃止する。
- `/agents/new`を唯一の作成入口とする。
- 依頼送信直後に仮Agentを作り、同じAgent詳細URLで進捗を表示する。
- 不足情報はAgent詳細の「次に必要なこと」に一件ずつ、理由と自動再開条件を添えて表示する。
- 完成時に別画面へ移動させず、同じAgent詳細がPreview結果へ切り替わる。
- 高度なChange Set、契約hash、相関IDは「詳細」内に置き、通常操作の主導線に出さない。

---

## 2. 現在地と残差

### 2.1 再利用する実装

- Builder Project / Run / Step / Human Actionの永続化、リース、停止・再開
- Capability Plan、Gap、OpenAPI / MCP Discovery、Change Set、Validation Evidence
- `builder_workspace` Runtime Job、隔離Docker volume、専用branch、非機微な結果契約
- Browser Runtimeのdomain allowlist、private IP拒否、Snapshot / Screenshot証跡
- Workflow v2のCondition、Approval、Wait、Retry、Compensate
- Previewと同一BuildのProduction昇格
- Runtime heartbeatによるTool Catalog同期
- Social Routerの`publish_post`、`get_job`、Idempotency-Key、暗黙の`external_send`承認

### 2.2 未完了の接続

| ID | 残差 | 現在の停止点 |
|---|---|---|
| GAP-01 | Builder用Agents API Session | Environment Keyをstandalone `codex exec`へ渡すと401。Capability広告を停止中 |
| GAP-02 | Git Provider App | local commit後のbranch push、PR作成、head SHA検証がない |
| GAP-03 | Adapter配布 | merge済み成果物をOCI imageまたはRuntime packageへ固定する経路がない |
| GAP-04 | Tool再登録 | 配布後のheartbeatをChange Setと結び、Connector / Tool Versionを確定する処理がない |
| GAP-05 | 実ファクタリングPreview | 反社Browser、社内履歴、否決一覧、通帳集計を同一Runで実行していない |
| GAP-06 | 実X投稿 | 承認後の匿名投稿とProvider Job成功確認をファクタリングE2Eで実施していない |
| GAP-07 | UXの二重入口 | 「エージェント」と「作成プロジェクト」が同格メニューになっている |

---

## 3. 完成時の処理フロー

```text
利用者が /agents/new へ業務を入力
  ↓
仮Agent + Builder Projectを同一トランザクションで作成
  ↓
要件分解 / 不足情報の質問 / Capability Plan
  ↓
既存Toolで解決できない能力だけCode Workspace Change Set化
  ↓
Control PlaneがAgents API Sessionを作成
  ↓
Runtime ControllerがSession Workerを起動
  ↓
codex exec-serverがEnvironment KeyでSessionへ接続
  ↓
Code Agentが隔離workspaceでclone / 実装 / test / commit
  ↓
Git Provider Appが専用branchをpush / PR作成
  ↓
CI成功 + review / merge + merge commit検証
  ↓
Adapter image/packageをBuildしdigest固定
  ↓
RuntimeへPreview配布
  ↓
heartbeatでConnector / Toolを再登録
  ↓
ファクタリングWorkflowとAgent Buildを固定
  ↓
非実在データで実Preview Run
  ↓
担当者が匿名投稿文を承認
  ↓
X投稿を1回だけ実行しProvider成功まで追跡
  ↓
Preview成功。Productionは別の管理者承認待ち
```

---

## 4. タスクA: Agent中心へのUX統合

### UX-001 Agentを作成作業の親にする

- `builder_projects`へ`agent_id`を追加する。
- 新規作成では仮AgentとBuilder Projectを同一トランザクションで作る。
- 既存Builder Projectは、生成済みReleaseのAgentへbackfillする。まだAgentがないProjectは初回再開時に仮Agentを作る。
- 1つのAgentに複数の作成・更新作業を紐付けられるようにする。

完了条件:

- 作成開始直後から`/agents/:agentId`で状態を確認できる。
- API / Worker再起動後も同じAgentへ復帰できる。
- 別組織のBuilder ProjectをAgent経由で参照できない。

### UX-002 作成入口を統合する

- `/agents/new`をBuilder Project作成フォームへ置き換える。
- 「Previewまで」「本番候補まで」を同じフォームで選択する。
- 旧Manifest直接作成はAgent詳細の「高度な設定」へ移す。
- `/builder-projects/new`は`/agents/new`へredirectする。

### UX-003 Agent詳細へ作成状況を統合する

- Agent詳細に「作成状況」タブを追加する。
- 通常表示は、現在の状態、次に必要な操作、直近の検証結果、Preview到達点に限定する。
- Plan、Change Set、Tests、Auditは折りたたみ可能な詳細表示にする。
- Human Actionは「なぜ必要か」「誰が行うか」「何を検知すると自動再開するか」を必ず表示する。

### UX-004 一覧とナビゲーションを整理する

- サイドバーから「作成プロジェクト」を削除する。
- Agent一覧に`作成中`、`準備待ち`、`Preview検証中`、`利用可能`、`失敗`を表示する。
- 作成途中のAgentも同じ一覧に表示する。
- 失敗したAgentには、原因と「再実行」を一覧から辿れるようにする。

### UX-005 旧URL互換

- `/builder-projects/:id`は紐付いた`/agents/:agentId?tab=build`へredirectする。
- Agent未作成の旧レコードだけは移行画面を表示し、自動backfill後にredirectする。
- APIは移行期間中だけ旧endpointを維持する。

UX受け入れ条件:

1. 初見の利用者が選ぶ作成入口は一つだけである。
2. 「Agentと作成プロジェクトのどちらを作るか」という選択が存在しない。
3. 作成、質問回答、Preview確認、実行が同じAgent詳細から完結する。
4. 主要画面で内部ID、契約hash、Runtime Job IDを理解する必要がない。

---

## 5. タスクB: Agents API SessionによるCode Agent

### SES-001 Builder Sessionの状態モデル

Builder Workspace Change Setごとに次を保持する。

- Studio側Session ID
- OpenAI Session ID
- Environment ID
- Runtime ID
- Change Set ID
- 状態: `creating / waiting_worker / connected / running / succeeded / failed / cancelled / expired`
- attempt、lease、期限、最終イベント時刻
- prompt hash、result hash、error class

生のprompt、生成コード、Environment Keyは証跡テーブルへ保存しない。

### SES-002 Agents API Session作成

- 組織のOpenAI Project設定を使用する。
- self-hosted environmentでSessionを作成する。
- Code Agentへ許可するbuilt-in toolは`apply_patch`、必要最小限の`shell`に限定する。
- Browser、外部MCP、業務用Connectionは初期状態では付けない。
- instructionsには対象ディレクトリ、安定入出力契約、テスト条件、禁止事項だけを入れる。
- 顧客名、口座番号、実通帳、Secretを入力へ含めない。

### SES-003 `codex exec-server`接続

- Session作成で返された`remote_url`と`environment_id`を既存`start_session`契約でRuntimeへ渡す。
- Environment KeyはRuntimeのSecret StoreからSession Workerへ注入する。
- Environment KeyをControl Plane、Builder prompt、Git、ログへ保存しない。
- `agent.session.environment.connected`を確認するまでCode Agentへの入力を送らない。
- connectedしない場合は期限内で再接続し、上限後は`environment_auth`として失敗させる。

### SES-004 Workspace準備

- Session WorkerはChange Set専用volumeをmountする。
- Git cloneはGit資格情報をモデルへ見せない専用credential helperまたはGit Gateway経由で行う。
- base branchのcommit SHAを開始時に固定する。
- main / protected branchへ直接pushできない権限にする。
- Workspace外のfilesystem、Docker socket、Runtime IAM credentialへアクセスさせない。

### SES-005 Code Agent入力と結果契約

Code Agentは次を実行する。

1. 対象契約と既存コードを読む
2. 指定されたAdapter directoryだけを変更する
3. unit / contract / security testを追加・実行する
4. Secret scanと`git diff --check`を実行する
5. 専用branchへlocal commitする
6. `/workspace/outputs/builder-result.json`へ型付き結果を書く

Control Planeへ返せる値:

- commit SHA
- base SHA
- diff SHA-256
- 変更ファイル相対パス
- テストcommand、終了コード、成功状態
- 一般化した実装要約

ソース本文、diff本文、環境変数、外部応答本文は返さない。

### SES-006 イベント監視と再開

- SSEは入力送信前に購読する。
- 切断時はSession retrieveで状態を照合する。
- root turn完了と`builder-result.json`検証の両方で成功とする。
- timeout、利用上限、Environment切断、テスト失敗を別error classで保存する。
- 再試行は同じChange Setとbase SHAを使い、重複Sessionをcleanupする。

SES受け入れ条件:

- Environment Keyで実`codex exec-server`がconnectedになる。
- public fixture repositoryでAdapterを生成し、テスト、local commit、型付き証跡取得まで成功する。
- 個人Codex設定や長期OpenAI API Keyをworkspaceへmountしない。
- Session停止後にcontainer、volume、環境キーが残らない。

---

## 6. タスクC: Git Provider Appによるbranch / PR

### GIT-001 Git Provider Connection

- 初期対応はGitHub Appとする。
- OAuth user tokenやPersonal Access Tokenを標準経路にしない。
- Installation ID、repository ID、許可repository、権限をConnection metadataへ保持する。
- App private key、installation tokenはSecret Storeだけに保存する。
- 最小権限はContents write、Pull requests write、Checks read、Metadata readとする。

### GIT-002 clone / fetch認証

- 短期installation tokenはGit操作の直前にControl PlaneまたはGit Gatewayで発行する。
- TokenをCode Agentの環境変数、prompt、remote URL、`.git/config`へ残さない。
- repository URL、owner、repository IDがConnectionのallowlistと一致しない場合は拒否する。

### GIT-003 branch push

- branch名は`builder/<agent-short-id>/<capability>/<attempt>`とする。
- base SHAが作成開始時の固定値と一致することをpush前に確認する。
- force push、tag作成、default branch更新を禁止する。
- 再試行時は同じChange Setから同じbranchを冪等更新する。

### GIT-004 Pull Request作成

- PR本文へChange Set、目的、変更ファイル、実行したテスト、diff hash、データ境界を記載する。
- Secret、顧客データ、モデルの内部推論を記載しない。
- 同じChange Setのopen PRがあれば新規作成せず更新する。
- PR URL、number、head SHA、base SHAをBuilder evidenceへ保存する。

### GIT-005 CI / merge検知

- Required Check成功をProvider APIまたはWebhookで検証する。
- Agent Studio上で管理者が変更内容を承認した後、確認済みhead SHAを固定してPRを既定branchへsquash mergeする。GitHub側のbranch protectionは迂回しない。
- 企業専用Toolは企業専用Integration Repositoryだけを対象にし、Agent Studio本体Repositoryへの反映を拒否する。
- 企業専用Integration Repositoryが未作成なら、`Administration: write`と`All repositories`が承認済みのGitHub Appでprivate Repositoryを自動作成する。Repository名、default branch、Connection登録、待機中Projectへの割り当てはBuilderが決め、利用者へ入力させない。
- merge後、merge commitが対象PRを含み、期待diff hashと対応することを確認する。
- close、base更新、競合、check失敗時は自動再生成せず、原因を表示して再計画する。

GIT受け入れ条件:

- GitHub App Connectionだけでprivate test repositoryへ専用branchをpushできる。
- 同一Change Setの再試行でPRが増殖しない。
- mainへの直接pushとforce pushが権限・コードの両方で拒否される。
- 管理者承認、Required Checks成功、merge検知後だけ次のAdapter配布へ進む。

---

## 7. タスクD: Adapter配布とConnector / Tool再登録

### REG-001 Adapter Descriptor

生成Adapterはrepository内に次の機械可読descriptorを持つ。

- connector key、display name、description
- Tool名、risk、input / output JSON Schema
- 実行方式: HTTP / MCP
- health endpoint
- Runtime network要件
- 必要Connection種別。Secret値は含めない
- source repository、merge commit、build context

### REG-002 Immutable package

- merge commitからCIでOCI imageまたは署名付きRuntime packageを生成する。
- tagではなくdigestをBuilder Buildへ固定する。
- SBOM、dependency scan、Secret scan、provenanceを生成する。
- Critical vulnerability、Secret検出、署名不一致では配布しない。

### REG-003 Preview Runtime配布

- Self-hosted Runtimeへdigest固定でPreview配布する。
- Runtime roleは対象repository / registry / serviceだけに限定する。
- health成功前は旧Versionを維持する。
- health失敗時は自動Rollbackし、Builderを失敗証跡付きで停止する。

### REG-004 Tool Catalog同期

- Runtime heartbeatのTool Catalogへconnector key、Tool契約hash、image digest、merge commitを含める。
- Control Planeは期待Change Setと一致するheartbeatだけを受理する。
- ConnectorとTool Versionは新規Versionとして登録し、既存Versionを書き換えない。
- 同期完了後、該当Capability GapとHuman Actionを自動完了する。
- Contract hashが違う場合はdriftとして停止する。

REG受け入れ条件:

- merge commitから作ったAdapterがPreview Runtimeでhealth成功する。
- heartbeat後に該当Connector / Tool VersionだけがRegistryへ追加される。
- Builderが無関係な既存ToolをAgent Buildへ混入させない。
- Runtime offline、digest不一致、contract driftでPreviewを開始しない。

---

## 8. タスクE: ファクタリング実Preview

### 8.1 Preview用データ

- すべて架空の法人、担当者、口座画像を使用する。
- 生の通帳画像はprivate object storageからSelf-hosted Runtimeだけが読む。
- モデルとControl Planeへ渡すのは月別入出金集計、名義一致、継続月数、定期入金有無などの最小結果だけとする。
- 反社照合サイトは利用許可された検証環境またはMockを使用する。
- 社内履歴DBと否決一覧DBはread-only credentialをTool Gatewayで管理する。

### 8.2 決定的なルール

金額比較、既存 / 新規判定、分岐はLLMではなくWorkflow / Rule Engineで行う。

| Case | 条件 | 期待結果 |
|---|---|---|
| F-01 | 過去問い合わせあり、100万円未満、口座確認正常 | `approve_candidate` |
| F-02 | 過去問い合わせあり、100万円以上 | `hold`、部長承認へ遷移 |
| F-03 | 新規、反社・否決一致なし、30万円未満、口座確認正常 | `approve_candidate` |
| F-04 | 新規、30万円以上 | 自動承認せず`hold` |
| F-05 | 反社一覧に一致 | `reject`、外部投稿不可 |
| F-06 | 社内否決一覧に一致 | `reject`、外部投稿不可 |
| F-07 | 名義不一致、継続入金不足、画像判読不能 | `hold`または`reject`。理由コード必須 |
| F-08 | Browser / DB / OCRのいずれかが確認不能 | fail closed。推測して審査を通さない |

金融判断のため、`approve_candidate`は最終的な契約・融資実行を意味しない。審査記録への書き戻し前に担当者承認を必須とする。

### 8.3 Tool実行順

1. 申込を型付きSchemaで検証
2. 顧客識別子を正規化
3. 過去問い合わせ履歴をread-only照合
4. 必要な場合だけ反社Browser Flowと社内否決一覧を照合
5. Runtime内で口座画像を解析
6. Rule Engineで可候補 / 否 / 保留と理由コードを決定
7. 担当者へ判断根拠を提示
8. 承認後、冪等キー付きで社内審査記録へ書き戻す
9. 公開可能な結果だけX投稿候補へ渡す

### 8.4 必須証跡

- 各Toolの開始・終了・入力hash・出力hash・Version
- BrowserのURL、取得時刻、Snapshot、Screenshot
- 生画像を外部へ送っていないこと
- 使用したRule Versionと閾値
- 結果、理由コード、担当者承認
- 書き戻しのIdempotency-Keyと確定状態

Preview受け入れ条件:

- F-01〜F-08がすべて期待どおり終了する。
- ToolがHTTP 200でも業務結果が不正なら成功扱いにしない。
- Preview Runが`completed / succeeded`で、必要Tool Callがすべて`completed`である。
- 実行後に生画像、氏名、口座番号がControl Planeログ、モデル出力、Audit detailへ残らない。

---

## 9. タスクF: 承認付き匿名X投稿

### PUB-001 公開payload

許可する項目:

- 匿名審査ID
- `可候補 / 否 / 保留`の一般化した結果
- 公開用理由コード
- 検証用の固定文言

禁止する項目:

- 氏名、会社名、取引先名
- 金額、期日、口座情報
- 反社・否決一覧への一致を人物と結びつける情報
- 内部スコア、DB ID、画像URL、署名URL

### PUB-002 承認画面

- 投稿先Xアカウント、最終本文、公開範囲を表示する。
- 承認画面を開いた時点の本文hashを固定する。
- 承認後に本文が変わった場合は承認を無効化する。
- 承認、却下、期限切れをAuditへ記録する。

### PUB-003 投稿と完了確認

- `publish_post`は承認後に1回だけ呼ぶ。
- `logical_post_id`はHTTP bodyへ含めず、Idempotency-Key生成だけに使用する。
- Provider Job IDを構造化保存する。
- `get_job`で`succeeded`を確認するまでWorkflowを完了しない。
- `failed`または`unknown`では自動再投稿せず停止する。
- Provider上のpost IDとpermalinkを証跡へ保存する。

PUB受け入れ条件:

- 承認前、却下後、期限切れ後の投稿は0件である。
- 同じWorkflow Runを再開しても投稿は1件だけである。
- 投稿本文に禁止項目が含まれる場合は承認済みでも送信しない。
- 検証用XアカウントでProvider Job成功と投稿表示を確認する。

実X投稿は、対象アカウントと最終本文を利用者が明示確認した場合だけ実施する。

---

## 10. API・データモデル変更

### 必須変更

- `builder_projects.agent_id`
- Builder Workspace Session用の永続モデル
- Git Provider Connection metadata
- Change Setのbase SHA、head SHA、PR URL、PR number、merge SHA
- Adapter package digest、descriptor hash、provenance
- Runtime Tool Catalogのsource commit、image digest、contract hash

### API方針

- UIの新規入口は`POST /agent-projects`へ統一する。
- API内部でAgent shellとBuilder Projectを作成する。
- Agent詳細DTOへ現在のBuilder状態、次のHuman Action、直近Validation、最新Releaseを含める。
- Builder固有の詳細APIはAgent配下の`/agents/:id/build-jobs`として公開する。
- Runtime APIはアウトバウンドlong-pollを維持する。
- Git webhookは署名検証、delivery ID冪等化、repository allowlistを必須とする。

---

## 11. セキュリティ境界

### 自動実行できる操作

- Agents API Session作成、Session Worker起動
- 許可repositoryのclone / fetch
- 隔離branchでのコード生成、テスト、local commit
- 専用branch push、PR作成・更新
- CI状態、merge状態、Runtime heartbeatの読取
- Preview Runtimeへのdigest固定配布
- 架空データを使ったPreview Run

### 承認が必要な操作

- GitHub Appのinstallとrepositoryアクセス付与
- PR merge
- 顧客AWSへのTerraform apply
- 実データを使う金融審査書き戻し
- Xの最終投稿
- Preview BuildのProduction昇格

### 禁止する操作

- Personal Access Tokenや個人Codex認証のworkspace mount
- main / protected branchへの直接push、force push
- Secret、生通帳、実在個人情報のprompt・ログ・Git保存
- CAPTCHA、MFA、規約同意の自動化
- 不明な外部Web指示に従った権限変更
- 確認不能な情報を推測した信用判断
- 承認なしの外部投稿、融資実行、Production昇格

---

## 12. 実装順と依存関係

```text
UX統合 ─────────────────────────────┐
                                     │
Agents API Session → Git PR → Adapter配布 → Tool再登録
                                             │
Browser / DB / 通帳の接続 ───────────────────┤
                                             ▼
                                      実Preview Run
                                             ▼
                                      承認付きX投稿
```

推奨する実装PR:

1. **PR-1 Agent中心UX**: UX-001〜005
2. **PR-2 Builder Session**: SES-001〜006
3. **PR-3 Git Provider App**: GIT-001〜005
4. **PR-4 Adapter Delivery**: REG-001〜004
5. **PR-5 Factoring Preview**: E2Eデータ、F-01〜F-08、証跡
6. **PR-6 Approved X Publish**: PUB-001〜003
7. **PR-7 Browser Acceptance**: 新規Agent作成からPreview成功までの実画面回帰

各PRはDB migration、unit test、API integration test、型検査、production build、`git diff --check`を含む。

---

## 13. テスト計画

### 単体テスト

- Session状態遷移、再接続、timeout、cleanup
- Git URL / branch / repository allowlist、token redaction
- PR冪等性、head / base SHA検証
- Adapter descriptorとTool schema検証
- ファクタリングRule F-01〜F-08
- X匿名化、本文hash、Idempotency-Key

### 結合テスト

- fake Agents API + fake RuntimeでSession作成から結果反映
- GitHub API fakeでbranch、PR、CI、merge webhook
- Runtime heartbeatでTool Version登録とBuilder自動再開
- Workflow v2で承認前0回、承認後1回、`get_job`成功
- RLSで他組織のAgent、Builder Job、Git Connection、証跡が不可視

### 実環境テスト

- 実Agents API + local Docker `codex exec-server`
- GitHub App + private test repository
- Self-hosted Runtime + fixture DB / object storage / Browser
- Social Router + 検証用Xアカウント

実環境テストは資格情報を必要とする。資格情報はConnection / Secret Storeからのみ使用し、テストログやスクリーンショットへ出さない。

### ブラウザ受け入れ

1. `/agents`から「新しいAgent」を押す。
2. ファクタリング業務を自然言語で入力する。
3. Agent詳細の「作成状況」で不足情報へ回答する。
4. Runtime、GitHub App、Connection準備後に自動再開する。
5. 作成されたPR、CI、merge、Tool登録を同じAgent画面で確認する。
6. F-01〜F-08のPreview結果と証跡を確認する。
7. X投稿承認画面で最終本文を確認する。
8. 承認後に投稿が1件だけ成功し、permalinkが表示される。
9. Agent一覧へ戻り、Agentが`利用可能`として表示される。

---

## 14. 最終Definition of Done

次をすべて満たした場合だけ本仕様を完了とする。

- Agentと作成プロジェクトの二重入口がない。
- Builder用Agents API Sessionが実`codex exec-server`へ接続する。
- Code Agentが隔離workspaceで生成・テスト・commitを完了する。
- GitHub Appで専用branchとPRを作り、mergeを検知する。
- merge commitから署名付きAdapter packageを作りPreview Runtimeへ配布する。
- heartbeatで期待したConnector / Tool Versionを再登録する。
- F-01〜F-08の実Previewがすべて成功する。
- 生通帳、Secret、実在個人情報がモデル、Control Plane、Git、ログへ出ない。
- X投稿は最終本文の担当者承認後に1回だけ実行される。
- Provider成功とpermalinkまで確認できる。
- Previewで検証した同一BuildがProduction承認候補として固定される。
- 全結果をAgent詳細の作成状況、Preview、Runs、Auditから追跡できる。

## 15. 明示的に完成とみなさない状態

- Manifest、Workflow、コード、PRのいずれかを作っただけ
- Docker containerが起動しただけ
- HTTP 200を受けたが業務結果を検証していない
- ToolをRegistryへ作ったがRuntimeでhealth確認していない
- Preview Runが`completed`でも`outcome=succeeded`または必須Tool Callが欠けている
- X APIがJobを受け付けただけで、Provider成功を確認していない
- 人間操作の完了後に開発者がDBやコードを手修正しないと再開できない
