# 実装状況（2026-09-22 時点）

要件定義書（docs/requirements.md）の §15 のフェーズごとに、実装したもの・確認したこと・残っていることをまとめる。
「確認済み」は、ローカルでは Docker の PostgreSQL と擬似 OpenAI を使った自動テスト・画面操作まで。
AWS は production の Control Plane と Sample A 社 Runtime の Terraform 適用、ECS の安定化、Control Plane の `/health` まで確認済み。
以下の従来フェーズ表は初期基盤の記録として残し、Agent版Vercel MVPの最新状態は次節を正とする。

## 最終完成仕様 v1.0 対応表（正本）

ステータスは `implemented`（実装のみ）、`tested_fake`（fixture/fakeを含む自動テスト）、`tested_local_real`（ローカル実プロセス/実Provider）、`tested_cloud_real`（実AWS/production）、`blocked_human`（資格情報・管理者承認・外部送信等のHuman Gate）のいずれかで表す。下位環境の成功を実AWS成功として扱わない。

| Workstream | 状態 | 2026-09-22の証跡と境界 |
|---|---|---|
| WS-01 正本化 | implemented | 本表と最終仕様を相互参照。古い履歴は削除せず、現在の判定を本表へ集約 |
| WS-02 自律診断・再実行 | tested_fake | 13 failure class、error fingerprint、class別上限/backoff/next action、lease所有者検査、遅延失敗拒否を実装。通常Workerと各integration Harnessを一意のqueueで分離し、別HarnessのJobをclaimしない契約テストを追加。自動追加commitの実Provider E2Eは未確認 |
| WS-03 モデル標準能力 | tested_fake | text/vision/OCR/image generation/web search/computer use Catalog、不要Custom Tool抑止、画像Artifact保存を実装。実OpenAIのOCR/画像/ニュース3本は未実施 |
| WS-04 Connection/Human Login | tested_fake | Browser Profile/Login Session/RLS/15分失効/Runtime結果照合/同一Builder自動再開、顧客Runtime内SSE-KMS Bucketを実装。Login Relay/Profile Brokerの実人間操作は未完成 |
| WS-05 Browser/Artifact/Computer | tested_fake | Artifact ID、MIME、size、SHA-256、安全検査、保持期限、Run/tenant分離、短期download URL、限定Computer Actionと操作後Screenshotを実装。Download→承認付きUploadは未実装 |
| WS-06 企業Runtime/AWS | tested_local_real | private repo/PR/package/heartbeat/Tool登録の縦切りとRuntime Terraformは既存実装。新規組織の実AWS apply、実DB、upgrade/orphan/署名不一致の一括Cloud E2Eは未実施 |
| WS-07 Adapter分離 | tested_fake | `shared_provider_adapter` / `organization_private_adapter`を追加し、既存の企業Repository強制を維持。共通Adapterの複数組織公開E2Eは未実施 |
| WS-08 Factoring | tested_fake | F-01〜F-08、可/否/保留、fail closed、承認、Provider Job/permalink契約はfixtureで成功。実Provider投稿はHuman Gate |
| WS-09 Production運用 | tested_fake | Worker/readiness、Runtime/deployment/drift health、Deployment API key、HMAC webhook、replay protection、rate/day cap、schedule、rollback、組織単位のfail-closed自動承認Policyと緊急停止を実装。実障害Cloud検証は未完 |
| WS-10 Agent UX | tested_local_real | 自然言語入口、Human Action、stage/log/elapsed/ETA/retry、Production health gateはローカル画面で既存確認。今回差分の全画面回帰は未実施 |
| WS-11 Cloud deploy | implemented | deploy設定欠落をhard fail、`/health/ready`、稼働task image SHA照合、migration/API/Web SHA記録を追加。対象commitのstaging/production実deployは未実施 |

### E2E-01〜17の現在地

| ID | 状態 | 未完了境界 |
|---|---|---|
| 01 文章生成・分類 | tested_fake | 実Production未実施 |
| 02 画像OCR | implemented | 実OpenAI入力Artifact E2E未実施 |
| 03 画像生成 | implemented | 実OpenAI生成/費用値E2E未実施 |
| 04 最新ニュース | implemented | 出典付き実Web Search E2E未実施 |
| 05 接続済みSaaS | tested_local_real | 実Production再検証待ち |
| 06 未接続OAuth | tested_fake | 実Provider consent待ち |
| 07 公開OpenAPI | tested_local_real | Production再検証待ち |
| 08 公開MCP | tested_local_real | Production再検証待ち |
| 09 公開Web | tested_local_real | Cloud Browser再検証待ち |
| 10 Human Login | tested_fake | 実Login Relay/Profile Broker未完成 |
| 11 企業専用DB | tested_local_real | 実AWS Runtime/実検証DB未実施 |
| 12 汎用Provider | implemented | 共通Repository mergeと複数組織利用未実施 |
| 13 承認付き書込 | tested_local_real | 対象Providerの最終外部作用はHuman Gate |
| 14 Factoring | tested_fake | 実Provider投稿/permalinkはHuman Gate |
| 15 自動修復 | tested_fake | schema/testへの追加commitとCI再走の実Git E2E未実施 |
| 16 障害復旧 | tested_fake | 実AWS Worker/Runtime停止再開未実施 |
| 17 Rollback | tested_fake | 実Production rollback後代表Run未実施 |

したがって、現時点では最終Definition of Done未達であり「Agent Studio完成」とは報告しない。

## Builder Agent（2026-09-21）

要件定義書 [builder-agent-requirements.md](builder-agent-requirements.md) のBuilder Agent MVPを、Preview Run、Workflow v2、Self-hosted Plan、同一BuildのProduction昇格まで通る縦切りとして実装した。

実装済み:

- Agent中心UX（UX-001〜005）。`/agents/new`だけを作成入口とし、仮Agentと内部Builder Jobを同一トランザクションで作成する。作成開始直後から同じ`/agents/:id?tab=build`で状態、次の操作、検証、Preview到達点を確認でき、完成時も別Agentへ切り替えない。
- `builder_projects.agent_id`を組織ID付き複合外部キーとして追加した。1 Agentに複数Jobを関連付けられ、旧Releaseはmigrationでbackfill、Agentのない旧Jobは初回移行または再実行時に仮Agentを自動生成する。
- Agent一覧に`作成中 / 準備待ち / Preview検証中 / 利用可能 / 失敗`を表示し、失敗時は原因と再実行へ遷移できる。サイドバーの「作成プロジェクト」を廃止し、旧`/builder-projects/new`と詳細URLはAgent導線へ転送する。
- Agent詳細の「作成状況」に、理由・担当・自動再開条件を備えたHuman Action、OpenAPI/MCP Discovery、直近Validation、Preview/Run導線、折りたたみ式のPlan/Change Set/Audit詳細を統合した。
- GitHub AppとSelf-host RuntimeをAgentごとの入力ではなく組織管理者の事前設定として扱い、`設定 > 実行・開発基盤`へ集約した。RuntimeのHeartbeat、Tool件数、稼働状態とGitHub Appのrepository/base branch/接続状態を同じ画面で確認できる。Builderで基盤が不足した場合もSecret入力を表示せずこの設定へ誘導し、接続またはHeartbeat検知後に自動再開する。
- Builder Workspace Change Setごとに`builder_workspace_sessions`を追加した。Studio/OpenAI/Environment/Runtime/Change Set ID、状態、attempt、lease、期限、最終イベント、prompt/result hash、error classだけをRLS下へ保持し、prompt本文、生成コード、Environment Keyは保存しない。
- Builderのコード生成を通常Runと同じAgents API self-hosted Session + `start_session` + `codex exec-server`経路へ移した。SSEを入力より先に購読し、`agent.session.environment.connected`確認後だけ指示を送り、root turn完了と`/workspace/outputs/builder-result.json`の型・Change Set・変更先・全テスト成功を両方検証して成功にする。
- Session Workerは`exec-server`起動前に非モデル処理でRepositoryをcloneし、base SHAを固定して専用branchへ切り替える。Docker launcherではChange Setごとのtmpfs workspaceを使用し、Environment Keyは従来どおりRuntime Secret Storeから`CODEX_API_KEY`へだけ注入する。
- 成功時にbase/commit/diff hash、変更ファイル、test結果、result hashだけをValidationへ保存し、Session削除とRuntimeの`stop_session`を実行する。失敗は`environment_auth / environment_disconnected / code_agent / expired / builder_session`等へ分類する。擬似Agents APIとRuntime APIを使う結合テストで、接続前未送信、接続、成果物検証、cleanupまで確認した。
- `builder_projects` / `builder_runs` / `builder_steps` / `capability_plans` / `capability_gaps` / `human_actions`。すべて`organization_id`、RLS、組織IDを含む複合外部キーを持つ。
- WorkerがDBリースでBuilder Runを取得し、依頼の整理、既存RegistryへのCapability解決、Gap分類、型付きHuman Action生成を行う。Worker停止時は期限切れリースから再取得する。
- `waiting_human_action`を失敗と分離し、完了記録後に次のBuilder Runを自動投入する。
- Overview / Plan / Setup / Changes / Tests / Preview / Releases / Auditの8タブを持つ作成プロジェクト画面。
- Builderロールによる作成・再実行・中止、Human Actionの担当ロール検査、監査ログと相関ID。
- API結合テストでWorker処理と別組織からの不可視性を確認。実ブラウザでも作成フォームからProjectを作り、`draft → analyzing → planning`とCapability Plan表示まで確認した。
- OpenAPI 3.0 / 3.1を検査し、選択したOperationからHTTP ConnectorとImmutableなTool Version 1を生成する。ローカル`$ref`は展開し、外部`$ref`、private IP、URL埋込認証情報、未対応認証は拒否する。
- methodと操作内容からRiskをコード側で決定し、OpenAPI拡張によるRisk引き下げを禁止した。Path/Query/JSON Body、成功Response Schema、POSTの冪等性キーをTool契約へ反映する。
- OpenAPI本文やSecretをDBへ保存せず、仕様ハッシュ・抽出メタデータ・生成Connector/Tool Version・Contract/Security/Smoke証跡だけを`Changes` / `Tests`へ保存する。
- API Key / Bearer / OAuthを識別し、Secret値をチャットやBuilder APIで受けず、型付きHuman Actionから既存Connection画面へ誘導する。接続テスト成功時は該当Actionを自動完了し、次のBuilder Runを投入する。
- 実ブラウザでOpenAPIの貼り付け、検査、1操作の選択生成を行い、`Changes`のConnector/Tool Version、`Tests`のContract/Security成功とSmoke待ち、`Setup`の接続Human Actionまで表示を確認した。
- 複雑なファクタリング依頼から、過去問い合わせ履歴、口座画像の取得元、反社照合先、自社否決一覧、100万円以上の遷移先、X公開範囲を「推測してはいけない業務事実」として具体的な入力欄へ分解する。回答はProjectへ保存し、Secretや実在顧客情報を含めず次のBuilder Runへ反映して自動再開する。
- 具体質問で解決する能力に、回答欄のない抽象的な確認カードを重ねて出さない。実ブラウザで6件へ回答し、再解析後に未回答カードが0件となること、回答内容を反映したCapability Plan v3が表示されることを確認した。
- 各接続先の回答には任意のOpenAPI/MCP URLを指定できる。公開HTTPS、2MB上限、Secretを含むURLの拒否、契約検査、業務とのOperation関連性確認を通過した仕様だけをConnector/Immutable Toolへ自動変換し、同じBuilder Runで再計画する。X投稿Toolが未登録の場合も同じ導線を使う。
- 複数回答から生成したConnectorを1つのBuildへ固定し、同じHTTP契約のRegistry Toolが既にある場合は、このProjectで利用者が明示した仕様を優先する。未解決Gapが1件でも残る間はPreviewを開始しない。
- OpenAPI/MCPも既存Toolもない社内データ源は、曖昧なGapで終わらせず、実装先Repository、基点branch、生成先、安定化する入出力契約を追加で質問する。回答から`code_workspace` Change Setを作り、専用branch、組織・Run隔離workspace、main直接push禁止、テスト通過前PR禁止、Secret/顧客データ非保存をSecurity証跡へ固定する。同じ能力の抽象確認やRepository質問は重複表示しない。
- `builder_workspace`をRuntimeの業務Toolとは別の管理能力として型付きHeartbeatへ追加した。対応Runtimeがなければ手動完了できない管理者Actionだけで停止し、能力を広告したHeartbeatで自動完了・再開する。対応RuntimeにはRepository、基点branch、専用branch、生成先、非機微な入出力契約だけをジョブとして渡す。
- ローカルSelf-hosted Runtime向けDocker Code Workspace Executorを追加した。使い捨てコンテナ内でclone、Codexによる最小差分生成、関連test/lint/typecheck、`git diff --check`、専用branchへのlocal commitを行い、ソース本文を返さずcommit SHA、diff SHA-256、変更ファイル名、テスト終了コードだけをControl Planeへ返す。資格情報はDocker引数へ出さず環境変数で注入し、workspaceはChange Set専用volumeへ隔離する。
- Code Workspace成功時はChange Setを`applied`へ進め、非機微なValidation証跡を固定する。同じcommitのbranch pushとPR作成はGit Connectionの自動検証条件として明示的に停止し、画面から誤って手動完了できない。
- 反社照合のように通常のWeb画面しかない外部データ源は、URL、照合キー、公開サイトかHuman Login必須かを型付きで質問する。通常画面URLをOpenAPIとして誤検査せず、hostname単位の`browser_flow` Change Setへ変換する。
- 公開サイトのBrowser Flowはexact domain allowlist、private IP拒否、外部コンテンツをuntrusted扱い、Snapshot証跡必須、コード実行禁止、公開Web全許可なしをSecurity証跡へ固定する。Preview開始時には生成Change Setの許可ドメインだけをBuildのBrowser接続へ反映する。
- ログイン必須サイトは`authenticated_restricted`としてHuman Loginだけで停止し、MFA、CAPTCHA、規約同意を自動化しない。Human Loginを通常の回答カードから誤って手動完了するAPI操作も拒否する。公開サイト分岐は実ブラウザで質問回答、Change Set、許可ドメイン、操作列、Security証跡まで確認した。
- 公開Browser Flowが確定した後の再開は、同じ要件をLLMへ再生成させず、前回Planと回答からManifestを決定的に再構成する。Browser Toolは明示されたBrowser Flowがある場合だけ採用し、URLという語だけを根拠に別のAgentへ混入させない。
- `browser_navigate` / `browser_snapshot` / `browser_screenshot`と対応Self-hosted Runtimeが揃った場合は、安全なBrowser Action群、Runtime Profile、許可ドメインを同じPreview Buildへ固定して開始する。不足時は必要Toolを明示した管理者Actionだけで停止し、手動完了を拒否する。Runtime heartbeatでTool CatalogとGatewayを検証できるとActionを自動完了してBuilder Runを再開する。
- 無関係または不正な仕様はConnector化せず、Discovery失敗証跡とURL修正カードを表示する。修正回答後は自動で再検査して復帰する。実ブラウザProject `c34682d8-796b-46d7-96ad-13bc2fcc6d85` では、6質問、OpenAPI URL入力、自動検査失敗、修正待ち、変更セット0件を確認した。
- 公開HTTPSのStreamable HTTP MCPへ`tools/list`を実行し、操作名、入力JSON Schema、`readOnlyHint` / `destructiveHint`を取得する。未申告の読取属性はwrite、destructive申告はdestructiveとして安全側に固定する。
- MCPサーバー側の操作名とStudio内のTool名を分離し、実行時の`allowed_tools`には元の操作名だけを設定する。検査後の再Discoveryで契約ハッシュが変化していた場合は生成を中止し、入力Schemaと外部入力フラグをImmutable Tool Versionへ保存する。
- MCP Discovery成功をContract / Security / `tools/list` Smoke証跡として保存する。認証不要のread操作はAgent / Build / Preview Runへ自動で進み、擬似Agents APIの実MCP Callイベント成功までE2Eで確認した。Bearer認証はSecretをBuilderへ渡さず、Connection作成のHuman Actionで停止する。
- 実ブラウザでMCP Discoveryフォーム、認証選択、OpenAPIとの併存レイアウト、private IP拒否エラーを確認した。
- MCP公式Reference Server `https://example-server.modelcontextprotocol.io/budget-allocator/mcp`へ実接続し、`get-budget-data`と入力Schemaを`tools/list`で取得した。`readOnlyHint`が未申告だったため、画面と生成提案の両方でwriteへ安全側判定されることを確認した（Connector反映・外部Tool実行はしていない）。
- Builder Change Setで生成したToolとCapability Resolverが選んだ既存Toolの和集合だけをAgent Manifestへ固定し、Registryの無関係なToolをPreview Buildへ混入させない。
- 認証不要または接続済みの読み取りToolでは、Agent Project、Immutable Build、Preview Deployment、Preview Runを自動作成する。`builder_releases`がAgent / Build / Deployment / Run / 構成ハッシュを1組として保持する。
- Runの`completed`だけでは完成扱いにせず、`outcome=succeeded`と選択Toolの`tool.call status=completed`を両方確認する。成功時だけProjectを`completed`（Production目標なら`production_pending_approval`）へ進め、失敗はPreview証跡へ固定する。
- Previewタブから生成AgentとRun詳細へ遷移でき、実行中はProject画面を自動更新する。
- 結合テストで公開OpenAPIの生成から擬似OpenAIによるTool実行、Preview成功までを確認した。さらに実OpenAIとGitHub公開APIでProject `25d47bea-e21d-491a-9b82-558cf507c038`、Build `334ac50e-4e32-44ce-82ee-a0cf9a1f1154`、Run `b2f26693-1089-41bc-b09e-081086cb4a46`を実行し、生成Toolの成功、`completed / succeeded`、画面のPreview受け入れ成功を確認した。

外部環境での残検証:

- GitHub App専用Connection、repository allowlist、短期Installation tokenの一回限り払い出し、Runtimeのstdin askpassによる`builder/*` push、PR冪等作成を実装した。Agent Studio上の管理者承認ではRequired Checks成功、head SHA、既定branch、企業専用Integration Repositoryであることを再検証し、squash mergeする。merge webhook受信後だけAdapter配布へ進む。秘密鍵とWebhook secretはSecret Storeだけへ保存し、通常のConnection secret更新経路から上書きできない。管理画面の専用フォームも実ブラウザで確認した。
- 企業専用Integration Repositoryが未作成でも、接続済みGitHub Appが`Administration: write`かつ`All repositories`でインストール済みなら、組織slugからprivate Repositoryを冪等作成し、default branchを取得してConnection登録と待機中Builderの保存先差し替えまで自動化した。実装先まで判定済みのCapabilityへ「利用する連携方法」を重ねて聞かず、待機中はHuman Actionの名称を進行欄とリアルタイムログへそのまま表示する。
- merge済みChange Setについて、Connectionへ固定したEd25519公開鍵でmerge SHA、descriptor/contract hash、OCI digest、SBOM digestのattestation署名を検証する。加えてdependency/Secret scan、provenanceを検証し、Runtime heartbeatのsource commit/digest/hash/signatureが一致したときだけConnectorと新しいTool Versionを登録する。drift時は登録せずBuilder証跡を失敗へ固定する。GitHub API fake + Runtime heartbeatの結合テストでbranch/PR/merge/package/Tool登録を通した。
- ファクタリングRule `F-01`〜`F-08`を`factoring-v2`として決定的に実装し、Browser/DB/OCR/コンプライアンス確認不能はfail closed、全結果を担当者承認必須とした。通帳fixtureの応答は集計値だけで、生本文を返さない。
- X公開は固定の匿名payloadだけを許可し、reject、長い数字、URL、mention、追加項目を実行直前にも拒否する。最終本文と投稿先を表示する明示承認、本文hash固定、`logical_post_id`のbody除外、`publish_post`一回、Provider Job `succeeded`待ち、post ID/permalinkのRun証跡表示まで実装した。
- 実ブラウザで`/agents/new`から架空ファクタリングAgentを作成し、同一Agent詳細の不足情報カード、回答後の自動再開、Agent一覧の`準備待ち`表示まで確認した（Agent `c437d2b2-ac93-4dda-be8d-2fd2a2d19f18`）。
- 認証が必要なOpenAPI / MCPはConnection接続テストまたはOAuth code交換後に自動再開する。実Provider認証を伴うBuilder Project E2Eは各Providerの資格情報が必要。
- Human Login browser profileのControl Planeメタデータ、顧客Runtime内SSE-KMS保存先、Login Session、Runtime結果検証、自動再開は実装済み。人が操作するOutbound RelayとProfile Brokerは未実装。Code WorkspaceはAgents API Session、`codex exec-server`、隔離workspace準備、生成・テスト・local commit、Artifact証跡反映、GitHub Appのbranch/PR、merge後package/Tool登録まで実装した。
- 最終Definition of Doneのうち、実GitHub Appの権限更新後に行うprivate repository自動作成、branch/PR/CI/Agent Studio承認によるmerge、実Self-hosted Runtimeへの署名package配布、実Environment Key + local Docker `codex exec-server`、F-01〜F-08の実Preview Run、検証用Xアカウントへの実投稿とpermalink確認は外部資格情報・最終承認が必要なため未実施。これらを実施するまでは完成扱いにしない。
- 実ブラウザProject `4a13c3fd-e649-4f51-9ecf-aff9e06a600f` で6件の業務質問へ非機微なデモ回答を入れ、問い合わせ履歴・社内否決一覧のRepository質問、2件の`code_workspace` Change Set、反社照合`browser_flow` Change Set、Code Workspace Runtime待ちへの遷移を確認した。旧standalone `codex exec`経路はEnvironment KeyでHTTP 401となったため使用を止め、個人Codex認証や長期OpenAI API Keyをmount/injectせず、Agents API Session + `codex exec-server`へ置き換えた。実OpenAI/実Dockerでの再受け入れは未実施。
- 顧客AWSへのTerraform applyは意図的にHuman Actionとして残し、BuilderはPlanとRuntime登録後の自動再開までを担当する。

## Agent版Vercel MVP（2026-09-20）

- Agent Projectを中心に、業務説明、必要なConnection/Variables、Preview、同一BuildのProduction昇格、Rollback、Health、Buildログ、Scheduleを一続きにした。AV-030、AV-043、AV-050、AV-051まで実装済み。
- 実OpenAI Session、ローカルの実Session Worker、Tool Gateway、Browser MCPでE2Eを実施した。
- 実画面でSocial Router（5操作）とBrowserを追加し、Preview/Production Connection、SNS投稿Agent、Preview Build、Production Deploymentを作成した。
- 分析Run `cdca2066-9305-4b24-abee-1e99e8c633b3` は、取得不能な外部データを推測せず、投稿案まで生成した。
- 投稿境界Run `e25d54ad-9420-4dbd-a0b7-1055a9e3c476` はApproval `82e1fcb9-c732-40e9-816b-6748f74c8916` で停止し、承認後に1回だけSocial Routerを呼んだ。内部用`logical_post_id`をbodyへ残したためHTTP 400となり、SNS投稿はない。このpayload不具合は修正済みだが、明示確認前のため再実投稿していない。
- Preview Deployment `f63d805f-8611-4941-a9b0-8aad637da7de` とProduction Deployment `3a6e3a9e-f677-443f-8ec0-0f0ce7d2d14e` は同じBuild `df669335-f921-4bd3-9ffd-2ee659ad9194` を参照する。
- 実投稿は対象アカウントと最終本文の明示確認後に限る。現在の対象アカウントはSocial Router側で再認証が必要で、作成したConnection用API Keyも読み取り専用・短期有効である。

### Zenn公開E2E（2026-09-21）

- Zenn公式のGitHub連携を使う `Zenn（GitHub連携）` Connectorと、`publish_zenn_article` Studio Functionを追加した。GitHub tokenはAgent StudioのConnectionに保存し、BuildやManifestには含めない。
- 実画面から `Zenn技術記事ライター` Agent（`c625e10b-9680-469a-b99c-037d6f224d51`）を作成し、Preview Run `6c9f5797-8010-48e9-8cb7-0dcc90077b08` を実行した。
- Agent Studioのツール実行が `zerotry-team/agent-studio-zenn-content` の `articles/5bb2b20d9fc62079.md` を作成し、Zenn Connect経由で [記事](https://zenn.dev/zerotry_iwata/articles/5bb2b20d9fc62079) が公開された。ログアウト状態の実ブラウザでタイトル、本文、トピック、公開日を確認済み。
- Runは `completed / succeeded`、ツール呼び出しは1回。Run IDから決定的なslugを生成するため、同じRunの再試行では新規記事を増やさず同じファイルを更新する。
- 当時のBuildには承認ポリシーを設定していなかったため承認レコードは0件だった。現在は再発防止として、`external_send` を入力元に関係なく暗黙の承認対象にしている。
- ただし、このE2EではZenn Connect用GitHub repositoryとAgent Studio Connectionを開発者が先に準備した。したがって「自然言語だけでAgent Studioが外部認証を含めてAgentを構築した」証拠にはしない。

### Agent Builder / Qiita（2026-09-21）

- 「Qiitaに技術記事を投稿するAgentを作って」という自然言語だけで、Agent Studioが記事生成とQiita公開の2要件へ分解し、`publish_qiita_article` を選択するところまで実ブラウザで確認した。Agent IDは `bb9f6eb1-ae86-44c3-aedd-c36fcd905e76`。
- 一発のManifest生成画面を `Agent Builder` として拡張し、Qiita Connectionがなければ同じ画面からOAuthを開始できるようにした。認可後はtokenをAPI側で交換してSecret Storeへ保存し、Previewへ権限を結び、既存の自動Preview作成へ戻る。
- Qiita Connectorは公式API v2の `POST /api/v2/items` を使用する。記事本文・タイトル・1〜5件のタグを入力とし、リスクは `external_send`。
- 現在の実ブラウザでは、Qiita OAuth applicationのClient ID / Client Secretが未設定であることをAgent Builder自身が検出して停止するところまで確認済み。QiitaアカウントとOAuth applicationの登録後に、実認可・Preview Run・公開記事確認を行う必要がある。
- 外部サービス側のOAuth applicationが未準備でも行き止まりにならないよう、Agent Builder内にowner向けの初回セットアップを追加した。Client IDとClient Secretを入力すると、SecretはSecret Storeだけに保存し、そのまま利用者認証へ遷移する。owner以外には運営者対応待ちを明示し、Agentを実行可能になるまで完成扱いにしない。

### Builder Project / Workflow v2 / Production（2026-09-21）

- Builder Projectを業務Agentから分離し、Run/Step lease、Capability Plan、Gap、Human Action、Discovery Source、Change Set、Validation Evidence、Releaseを組織別RLS下で永続化した。OpenAPI/MCPの契約ハッシュを固定し、変更後の仕様を同じ提案としてapplyできない。
- 認証不要のOpenAPI/MCPは、Connector/Tool生成、Contract/Security/Smoke、Immutable Build、実Preview Run、生成Toolの成功イベント確認まで自動で進む。Connection検証またはOAuth code交換が成功すると、該当Human Actionを完了してBuilder Runを自動再開する。
- Workflow v2はAgent/Tool/Condition/Approval/Transform/Wait/Compensate、明示遷移、決定的比較、再試行、補償、永続wait、承認後再開を実装した。旧Workflowは配列順実行のまま互換性を維持する。
- Self-hostedはBuilderが顧客AWS、リージョン、IAM roleを固定したTerraform Plan証跡を作り、applyだけを`aws_admin_action`として停止する。署名付きRuntime登録が成功すると自動でHuman Actionを完了して再開する。Runtime heartbeatのTool CatalogはRuntime Connector/Tool Versionへ同期し、Control PlaneにSecret値を保存しない。
- Production対象はPreview成功後に管理者承認を必須とし、再コンパイルせず同じBuild IDと構成ハッシュを昇格する。限定Production Runで期待Toolの成功まで検証し、失敗時は承認時に固定した直前DeploymentへRollbackする。完了後はBuild、Deployment health、Runtime、Connectionのdriftを定期検査し、不整合時はProjectを停止する。
- ファクタリングデモへRuntime内PDF集計、Mockコンプライアンス、決定的な可/否/保留ルール、`idempotency_key`付き審査書き戻しを追加した。PDF fixtureの生本文は応答へ含めず、月別金額、名義一致、継続月数だけを返す。
- 必要なファクタリングToolが揃うと、申込取得、Runtime内PDF集計、コンプライアンス確認、決定的ルール、条件分岐、人間承認、冪等書き戻しを持つWorkflow v2と可・否・保留のEval CaseをBuilder成果物として自動生成する。X公開が指定されている場合は、Human Actionで確定した`account_id`、結果と一般化理由コードだけの公開文、Workflow Run IDによる冪等投稿を同じWorkflowへ固定する。
- `external_send`は入力元に関係なく実行直前の承認を暗黙に付与する。したがって、Xや外部SNSへの公開は、Builderが生成したManifestに明示ポリシーがなくても無人実行されない。
- `publish_post`のHTTP受付成功だけではWorkflowを完了せず、保存したProvider Jobを`get_job`で追跡し、`succeeded`になったときだけ完了する。`failed`または`unknown`では二重投稿せず失敗として停止する。
- 初回の業務ヒアリング中は、同じ能力について推測したConnector接続を重ねて表示しない。回答後の再計画で実際に選ばれたConnectionだけを案内する。実OpenAIの要件整理には90秒の上限を設け、Worker leaseを越えて無期限に占有しない。
- 契約も既存Toolもない社内接続は、Repository、基点branch、生成先、安定入出力を型付きHuman Actionで取得し、専用branchと隔離workspaceを持つ`code_workspace` Change Setへ変換する。Capability PlanはLLMが社内データ源を落としても不足能力を決定的に補い、解決方法を`generate_code`として表示する。

現在の検証境界:

- 単体テスト、本番ビルド、DB migration、API結合テストでPreview→同一Build Production昇格、Workflow v2分岐/Wait/承認/再開、Runtime登録、Tool実行を確認済み。
- 顧客AWSへの実Terraform apply、実顧客IdPでのHuman Login profile保存、Code Workspaceの実Codexコンテナ実行と外部Git providerへのPR作成は外部資格情報と管理者操作を伴うため、このローカル検証では実行していない。Runtimeジョブ発行、成功結果の反映、Git公開待ちへの遷移はAPI結合テストで確認済み。

今回追加済み:

- Connectionの期限自動検知、revoke、実接続テスト、ローテーションUI。Social Router Previewの実接続確認も成功。
- Agent Projectから設定するSchedule triggerとWorkerによるRun生成。
- Social Router Job IDの構造化保存、自動`get_job`追跡、Runタイムラインとの相関。不明時も自動再投稿しない。
- Tool失敗時の`completed_with_errors` Outcome、警告表示、Health集計。
- Computer / Browser Runtime Phase 1とNetwork/Securityの主要部。RunごとのBrowser Session Task、Private IPの動的Session Grant、Tool Gatewayの動的routing、Screenshot/Snapshot/Browser Action、公開Web向け制限付きコード実行、Orphan Sweeperを実装。
- Browser専用Egress Proxyを追加し、FQDN allowlist、IP literal、private/link-local/metadata系address拒否を強制。`proxy` modeではBrowser TaskのSecurity Groupから直接Internet向け80/443を削除した。
- `browser-automation` Connectorを1能力として扱い、Build時に内部Action群へ展開。`authenticated_restricted`では`browser_exec_js`をContract、Gateway、Workerの3箇所で無効化した。
- Agent作成後はBrowser内部Actionを個別表示せず、必要なConnectionと許可ドメインだけを確認する。Browser接続範囲が未設定の間はPreviewを作成しないことをAPI結合テストと実ブラウザで確認した。
- 新しいBrowser Worker + Egress ProxyをDocker上で接続し、Proxy経由で`https://example.com`を開き、画像応答とSnapshot内容を確認した。Browser ProfileのControl Plane契約、Artifact downloadメタデータ、限定Computer Actionは追加したが、AWS上の実OpenAI E2E、Human Login Relay、承認付きUploadは未確認・未実装。

残件:

- Providerへの定期Health check（手動の実接続確認は実装済み）。
- Project SettingsのInstructions、Permissions、Environment選択画面。
- Deployment単位のAPI Key、Webhook trigger、rate/day capはAPI実装済み。管理UIは未実装。

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
| 型・単体テスト | `yarn type-check` / `yarn lint` / `yarn test`（全ワークスペース） | 型・lint成功、421 件すべて成功 |
| 組織の分離・実行の流れ | `yarn workspace @agent-studio/api test:integration --run --maxWorkers=1 --minWorkers=1`（PostgreSQL、通常Worker稼働中） | 59 件すべて成功。Builderの質問・回答・自動Discovery・公開/Human Login Browser Flow・Browser Runtime自動再開・複数Connector固定・修正後再開、OpenAPI / MCP生成 → Preview Run、GitHub App branch/PR/merge/package/Tool登録、Workflow v2、承認付き外部作用とProvider Job成功待ち、同一BuildのProduction昇格、組織Policyによる自動昇格、Harness単位queue分離を含む |
| ビルド | `yarn build`、`docker build`（api / web / runtime の全イメージ） | 成功 |
| Terraform | `fmt` / `validate`（5 つのルートモジュール）、モックのプロバイダーでの apply | 成功 |
| ワークフロー | actionlint | 指摘なし |
| Runtime の実プロセス | 手元で API + Controller + Tool Gateway + 社内 API モックを動かし、MCP クライアントで呼び出し | 登録・ハートビート・ツールの絞り込み・Runtime 側の拒否・承認待ち → 承認 → 1 回だけ実行 → 監査ログ まで確認 |
| 画面 | 開発用ログインでダッシュボード・実行の詳細を表示 | 表示できる |
| AWS production 基盤 | GitHub Actions で Control Plane / Sample A 社 Runtime を適用し、ECS の安定化と公開 URL の `/health` を確認 | 基盤は成功。本物の OpenAI / Claude と Runtime セッションの E2E は未確認 |

## 気づいている改善点

- 承認依頼の通知がない（画面のみ）
- API の `/runs/:id/events` はポーリング（2 秒ごと）。多数の利用者が同時に見る場合は SSE などを検討する

## 本番に出す前に必要な作業

1. production の `as-production/anthropic-api-key` と、組織ごとの OpenAI Project ID / アプリキー / 環境キーを設定する
2. Runtime の Bootstrap Token と production の組織 ID・接続先を合わせ、Runtime 登録から Session Worker 接続まで確認する
3. Phase 0 の技術検証（特に Fargate 上の `codex exec-server`、環境キーの発行）
4. 顧客への説明: OpenAI に送られるデータの範囲、米国での処理、ZDR 非対応（要件定義書 §4.2-A / SEC-21）
