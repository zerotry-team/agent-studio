# Agent Studio

企業ごとに分離された実行環境で、業務用の AI エージェントを設計・デプロイ・実行・監査する SaaS。

- **Agent Studio（Control Plane）**: 利用者・組織、Agent の定義（Manifest）、ツール、ポリシー・承認、デプロイ、実行履歴、監査ログ
- **Company Runtime（Execution Plane）**: 企業ごとの AWS アカウントで動く実行環境。`codex exec-server`（セッションごとの Fargate タスク）と、業務システムの認証情報を持つ Tool Gateway
- エージェントの実行は OpenAI Agents API（`openai_hosted` / `self_hosted`）

設計の詳細は [docs/requirements.md](docs/requirements.md)（要件定義書）と [docs/architecture/](docs/architecture/) を参照。

## 何ができるか

**日本語で頼むだけで、業務用の AI Agent を作り、会社の中で動かす。**

```text
Web アプリを自然言語で作る  → Lovable
AI Agent を自然言語で作る   → Agent Studio
```

中心にいるのは **Agent Builder Agent**（Agent を作る Agent）。日本語の依頼を仕事に分解し、社内の Tool・Connector から再利用できる部品を探し、足りなければ Backend Tool を実装・テストし、専用 branch・PR・CI で版を固定し、企業の AWS 上の Runtime へ Preview 配備して、実際に動かした証跡を残すところまでを自分で進める。

既存の Agent Builder が作れるのは、Tool と接続がすでにそろっている業務だけで、足りない瞬間にエンジニアの出番になる。Agent Studio は、その「足りない部分を作る仕事」自体を Agent に任せる。作られた Tool は社内の部品として残るので、Agent を作るほど次の Agent が速くなる。

用語:

- **Tool**: Agent が DB を読む、計算する、結果を書くための部品
- **Connector**: 社内 DB や外部サービスへ安全につなぐ接続口
- **Runtime**: 秘密データを外へ出さずに Agent を動かす、企業内の実行環境

### Builder が進める工程

1. 日本語の依頼を読み、入力・出力・制約・必要な能力に分解する
2. 社内の Tool / Connector 一覧から、再利用できる部品を探す
3. 足りない機能だけを、隔離された作業場で実装・テストする
4. 専用 branch・PR・CI を通し、成果物の版を固定する（Build）
5. 企業の Runtime へ Preview 配備する
6. 実際に動かし、Tool 呼び出し・承認・結果を検証する
7. 検証済みの Build だけを、本番昇格の候補にする

Builder は手順をなぞるのではなく、依頼ごとに判断する。要約・比較のようにモデルだけで済む能力には Tool を作らず、外部データの取得・更新が必要な能力だけ Tool にする。承認済みの Tool があれば再利用し、なければ OpenAPI / MCP から変換するか Adapter を実装する。読み取りは自動、書き込みは承認ゲート付き、外部公開は別ゲートと、操作ごとに危険度を分ける。失敗は13種類に分類し、「待って再試行」「自分で直す」「人に聞く」を選ぶ。

人に返すのは、本人にしかできない操作だけ（OAuth 同意・ログイン・API キーの入力、顧客 AWS の管理者承認、業務ルールの確定、本番公開の承認）。秘密情報の値はモデルを通さず、専用の入力欄から Secrets Manager へ直接保存する。接続テストが通れば、止まっていた作成作業は自動で再開する。

### 実例: ファクタリング事前審査

金融機関のコア業務であるファクタリング（売掛金の買い取りによる早期資金化）の事前審査を、日本語の依頼だけから自律化できる。資料が多く、判断にブレが許されず、データを外へ出せず、説明責任がある——「AI に任せたいが、任せきれない」業務の代表例。

Builder が組み立てた Tool と権限:

| 能力 | Tool | 権限 |
|---|---|---|
| 申込と過去の審査履歴を取得 | `get_application` | 読み取り |
| 通帳を企業 AWS 内で集計 | `analyze_bank_statement` | 読み取り（原本は返さない） |
| コンプライアンス情報を照合 | `check_compliance` | 読み取り |
| 固定ルールで候補を計算 | `evaluate_factoring_rules` | 計算のみ |
| 審査結果を社内 DB に記録 | `record_screening` | 書き込み（承認後・1回だけ） |

生成された審査 Workflow は、① 申込取得（失敗時は2回まで再試行）→ ② 企業 AWS 内で通帳を集計 → ③ コンプライアンス照合 → ④ 固定ルールで候補を計算 → ⑤ 候補で分岐して担当者が確認 → ⑥ 承認されたら社内 DB に1回だけ記録、と進む。Tool の呼び出し順・再試行・分岐・承認の位置まで Builder が組み立てる。

判定 Tool が返すのは、画面表示と監査にそのまま使える構造化データ（判定候補・理由コード・判断に使った事実・ルール版・人の承認要否）。何を読み、どの版のルールで、なぜその候補になったかを後から追跡できる。

## 設計の考え方

### AI に仕事を任せ、鍵は渡さない

実行環境ごと顧客の AWS アカウントに置く（Self-hosted）。Control Plane（Agent Studio）が持つのは Agent 定義・Build・実行履歴・承認・監査ログで、業務データと認証情報は Execution Plane（Runtime）から出ない。

- 顧客 AWS に受信ポートを開けない。Runtime → Agent Studio のアウトバウンド HTTPS だけ（Heartbeat、Long Poll、実行結果・監査イベント）。初回は1回だけ使える Bootstrap Token で登録し、以降は15分で失効する Runtime Token
- 危険度の違う仕事を別コンテナに分ける。`session-worker`（Run ごとのコード実行）には受信ポートも AWS 権限も業務の認証情報も置かない。`browser-worker` は Run ごとの Chromium、`egress-proxy` は許可ドメイン以外・private IP・メタデータエンドポイントを遮断（DNS で引いた IP を検査してからその IP へ直接つなぐ）
- 社内 DB に触れるのは `tool-gateway` だけ。自由な SQL は通さず、Tool を呼ぶたびに権限・入力の形・承認・重複実行をモデルの外側で検査する。読み取りと書き込みは別の権限で、認証情報はその瞬間だけ注入する
- 組織の分離はアプリではなく DB で保証する。組織に属する全テーブルに `organization_id` + RLS + 複合外部キー `(organization_id, id)`。組織をまたげるのは限られた DB 関数だけ

### AI の自己申告を信じない

コードを書かせること自体は難しくない。難しいのは、AI が書いたコードを本番の部品にすること。

- コードを書くコンテナは GitHub に push できない。push は別コンテナが担当し、鍵はリポジトリを絞った1ジョブ1回限りの GitHub App トークンを tmpfs 経由で渡す。`builder/*` 以外への push と force push は拒否し、前後でコミット SHA を照合する
- 作業結果は、ネットワークを切った読み取り専用の別コンテナで回収する。全テストが passed・終了コード 0・変更が Adapter のディレクトリ内、を満たさなければ不合格
- マージしたコードと動いているコードの一致を二重に照合する。CI が報告するイメージ digest・SBOM・脆弱性0件・秘密情報0件を鵜呑みにせずハッシュを再計算して Ed25519 署名を検証し、配備後は Heartbeat が報告する Tool と1つでも違えば `contract_drift` として登録を止める
- OpenAPI / MCP から Tool に変換するときも、危険度の判断はモデルに任せない。GET は読み取り、DELETE は破壊的操作、それ以外は書き込み。仕様側で危険度を上げられても下げられない。POST には重複防止キーを自動で付け、読み取り専用を宣言しない MCP Tool は書き込みとして扱い、社内 IP や localhost を指す仕様は受け付けない

### 判断はブレさせない

LLM と固定ルールの役割を分ける。日本語の依頼を仕事に分解する、Tool を探して組み立てる、取得結果を整理する、理由を人に分かる言葉で説明する——ここまでが LLM。判定そのものは版付きの固定ルールが行う。

同じ入力と同じルール版なら、必ず同じ結論になる。確認できないデータは推測で埋めず「保留」にする。原本は企業 AWS 内で集計し、モデルには事実だけを渡す。AI は作り、読み、整理し、説明する。判定はルール。最後は人が承認する。

### 止まっても、途中から立て直す

- 失敗は13種類（要件の不備、能力不足、接続なし、権限不足、Runtime 停止、git、パッケージ、Tool 登録、Build、Preview、本番、設定のずれ、ポリシー拒否）に分類し、フィンガープリント（SHA-256）で同一エラーを見分け、種類ごとに再試行上限とバックオフを変える
- 待ちが発生するたびに「何が起きたら再開するか」を登録し、条件がそろえば止まったところから自動で続く。PR は作り直さず再利用、GitHub 通知は配信 ID で重複排除、Tool 登録は1回だけ。何度やり直しても成果物は1つ
- ジョブは `FOR UPDATE SKIP LOCKED` と lease で取り合い、所有権を失ったあとに届いた結果は捨てる。Worker が落ちても二重実行しない
- デプロイは `terraform apply` で終わらせず、起動した ECS タスクのイメージが要求した commit SHA と一致するかまで照合する。本番へは Build を作り直さず、Preview で動いたものをそのまま昇格する

### 承認の粒度は組織が選ぶ

OpenAI Agents API には承認で止める仕組みも webhook もないため、「止めて、承認されたら再開する」は Agent Studio と Tool Gateway 側で実装している。

| モード | 自動で進む範囲 | 向いている場面 |
|---|---|---|
| 個別承認 | なし（全部人が確認） | 導入初期 |
| 安全操作を自動承認 | 読み取りだけ | 調査・検索中心の Agent |
| ポリシー内を自動承認 | 許可した接続先・操作・HTTP メソッドだけ | 定型業務を止めずに回したい |
| 完全自律運転 | 登録済みの能力を Owner が包括承認 | 成熟した業務を端から端まで自動化 |

完全自律運転でも、秘密情報の登録・OAuth 同意・新しい接続先・権限拡大・予算上限の変更は自動化しない。実行数・件数・1日の費用に上限があり、有効期限切れや緊急停止で手動承認に戻る。

### モデル接続を差し替えられる

モデルへの接続は OpenAI 互換のゲートウェイ [OrcaRouter](https://www.orcarouter.ai/ja) に切り替えられる。

- Builder のテキスト生成と画像生成を、組織の管理者が処理ごとに ON/OFF できる
- モデル名はコードに書かず組織設定で差し替える
- 構造化出力は Tool Calling（`submit_agent_project_draft`）を強制し、引数を Zod スキーマで検証してから採用する
- 組織ごとのキーは Secrets Manager に保存し、画面には再表示しない
- ON なのにキーがなければ、黙って OpenAI へ流さずエラーで止める（管理者が選んだ事業者と実際に処理した事業者が違うと、監査で説明できないため）。障害時は管理画面のチェックを外せば既存の OpenAI 経路へ戻る

### 企業ごとに分離しても、インフラは手作りしない

安全設計は共通の Terraform モジュール `tenant-runtime` にまとめ、企業ごとの差分は `infra/company/<企業>/config.yaml` だけ。GitHub Actions が「企業 × 環境」ごとに OIDC で対象 AWS に入り `terraform apply` する。1回の apply で、2AZ の VPC・Private Subnet・NAT・DNS Firewall、ECS Cluster・Runtime Controller・Tool Gateway、Run ごとの使い捨て Worker、Secrets Manager と KMS 鍵（値は空）、CloudWatch Logs（90日保持）が作られる。本番への apply は GitHub Environment の管理者承認で止まる。

費用は「共通 Control Plane + 企業環境の数 × 固定費 + 実行した秒数」で、同じ Runtime に Agent を10個載せても固定費は10倍にならない。


## 評価項目への回答

**① セキュリティ ② コストパフォーマンス ③ 信頼性・堅牢性 ④ 自律性 ⑤ アイデア・独創性——5項目すべてを満たしている。**

### ① セキュリティ

**秘密データも鍵も、顧客の AWS から出さない。AI には1つの鍵束を持たせない。**

- 実行環境（Runtime）ごと顧客の AWS アカウントに配備する Self-hosted 構成。通帳も口座情報も DB の認証情報も顧客 AWS の中で完結し、Agent Studio が持つのは「何が起きたか」の記録だけ
- 顧客側に受信ポートを開けない。Runtime → Agent Studio のアウトバウンド HTTPS だけで、ファイアウォールの穴あけ申請なしに導入できる。初回登録は1回だけ使える Bootstrap Token、以降は15分で失効する Runtime Token
- 危険度の違う仕事を別コンテナに分離する。`session-worker`（Run ごとのコード実行）には受信ポートも AWS 権限も業務の認証情報も置かない。前提は「AI が動かすコードは、中身をモデルに読まれても困らない場所で動かす」
- `egress-proxy` は許可ドメイン以外・private IP・`169.254.169.254` を遮断し、DNS で引いた IP をすべて検査してからその IP へ直接つなぐ（`::ffff:172.16.0.1` のような IPv4 を包んだ IPv6 も拒否）
- 社内 DB への唯一の入口は `tool-gateway`。自由な SQL は通さず、Tool を呼ぶたびに権限・入力の形・承認・重複実行をモデルの外側で検査する。読み取りと書き込みは別の権限で、認証情報はその瞬間だけ注入する
- コーディング AI に git の鍵を渡さない。push は別コンテナが担当し、リポジトリを絞った1ジョブ1回限りの GitHub App トークンを tmpfs 経由で渡す。`builder/*` 以外への push と force push は拒否し、前後でコミット SHA を照合するので、プロンプトインジェクションで乗っ取られても main は書き換えられない
- 秘密情報の値はモデルを通さない。専用の入力欄から Secrets Manager へ直接保存し、DB にもログにも参照だけを残す
- 組織の分離はアプリではなく DB で保証する。組織に属する全テーブルに `organization_id` + RLS + 複合外部キー `(organization_id, id)`。「全テーブルで RLS が有効」を結合テストで検査し、組織をまたげるのは限られた DB 関数だけ

### ② コストパフォーマンス

**Agent を増やしても、固定費は増えない。**

```text
月額 = 共通 Control Plane + 企業環境の数 × 固定費 + 実行した秒数
```

| 項目 | 金額 | 根拠 |
|---|---|---|
| 共通 Control Plane（本番） | 約 $342/月 | AWS 公開料金から積算 |
| ↑の実請求（Cost Explorer） | 1日 $11.66 → 月換算 約 $350 | 見積りとの差は約2% |
| 企業 Runtime 1環境 | 約 $74/月（ブラウザ込みで約 $85） | 3分の2は NAT＝ネットワーク境界の維持費 |
| 審査1回（ブラウザ込み15分） | 約 $0.047（約7円） | Fargate の秒課金。5分で終われば約3分の1 |

- 同じ Runtime に Agent を10個載せても固定費は10倍にならない。増えるのは実行秒数だけ
- Self-hosted なので企業 Runtime 分は顧客の AWS 請求に乗り、運営側は共通部分から始められる
- 企業ごとにインフラを手作りしない。安全設計は共通の Terraform モジュール `tenant-runtime` にまとめ、企業ごとの差分は `infra/company/<企業>/config.yaml` だけ
- 業務側の効果（月100件の事前審査、1件45分 → 人の最終確認10分の前提）: 75時間 → 約16.7時間、約58時間/月（約78%）の削減
- Agent を作る側も、日本語の依頼から Preview で動くまで約30分。従来は業務担当・AI エンジニア・Backend・インフラ・セキュリティが調整しながら何人日もかける工程

金額は東京リージョン、2026年9月22日時点の公開料金、1ドル=150円で算出（モデル API 料金・税は含まない）。業務削減は実測ではなく前提を置いた試算。

### ③ 信頼性・堅牢性

**判断はブレず、落ちても二重に実行しない。**

- 金融判断を LLM に丸投げしない。依頼の分解・Tool の組み立て・結果の整理・理由の説明は LLM、判定そのものは版付きの固定ルール（`factoring-v2`）。同じ入力と同じルール版なら必ず同じ候補になる
- 確認できないデータは推測で埋めず「保留」にする。通帳は企業 AWS 内で集計し、モデルには「3か月連続で入金、名義一致」という事実だけを渡す（`raw_text_included: false`）
- 失敗は13種類（要件の不備、能力不足、接続なし、権限不足、Runtime 停止、git、パッケージ、Tool 登録、Build、Preview、本番、設定のずれ、ポリシー拒否）に分類し、フィンガープリント（SHA-256）で同一エラーを見分け、種類ごとに再試行上限とバックオフを変える
- 人待ちのたびに「何が起きたら再開するか」を登録し、条件がそろえば止まったところから自動で続く。PR は作り直さず再利用、GitHub 通知は配信 ID で重複排除、Tool 登録は1回だけ。何度やり直しても成果物は1つ
- ジョブは `FOR UPDATE SKIP LOCKED` と lease で取り合い、所有権を失ったあとに届いた結果は捨てる。Worker が落ちても二重実行しない
- AI の「テスト通りました」を信じない。作業結果はネットワークを切った読み取り専用の別コンテナで回収し、全テスト passed・終了コード 0・変更が Adapter のディレクトリ内、を満たさなければ不合格
- 「マージしたコード」と「動いているコード」の一致を二重に照合する。CI が報告するイメージ digest・SBOM・脆弱性0件・秘密情報0件を鵜呑みにせずハッシュを再計算して Ed25519 署名を検証し、配備後は Heartbeat が報告する Tool と1つでも違えば `contract_drift` として登録を止める
- デプロイは `terraform apply` で終わらせず、起動した ECS タスクのイメージが要求した commit SHA と一致するかまで照合する。本番へは Build を作り直さず、Preview で動いたものをそのまま昇格する

### ④ 自律性

**Agent 定義を書くだけでなく、足りない Backend とデプロイ先まで自分で作る。**

Tool が足りないとき、Builder は次を自分で進める。

```text
 1. 足りない能力を検出       Tool 一覧に候補がない → 「作る」と判断
 2. 置き場所を決める         社内システム向け → 顧客の Runtime で動く企業専用 Adapter
 3. リポジトリを用意         GitHub App で企業専用の private リポジトリを自動作成
 4. 顧客 AWS の中で実装      コーディング AI が builder/* で Adapter とテストを書き、通るまで直す
 5. 結果を疑って回収         ネットワークなしの別コンテナで読み、合否を判定
 6. push と PR               1回しか使えない鍵で push し、PR を作成
 7. マージ                   CI がすべて通った時点で、検証したコミットに固定して squash merge
 8. 成果物を封印             digest・SBOM・脆弱性0件・秘密情報0件を署名付きで検証
 9. 動いていることを確認     Heartbeat の Tool が封印した成果物と一致したら登録
10. 自動で再開               止まっていた Agent 作成が続きから進み、Preview で動く
```

- 手順をなぞるのではなく判断する。モデルだけで済む能力には Tool を作らず、外部データの取得・更新が必要な能力だけ Tool にする。承認済み Tool があれば再利用し、なければ OpenAPI / MCP から変換するか Adapter を実装する
- 操作ごとに危険度を分けて、どこまで自動で進めるかを決める（読み取りは自動、書き込みは承認ゲート、外部公開は別ゲート）
- API 仕様から認証方式（OAuth2 / API キーなど）を読み取り、接続の設定と入力欄まで用意する
- Workflow も自律的に組み立てる。Tool の呼び出し順・再試行・分岐・承認の位置・否決時に外部公開しない分岐まで生成物に含まれる
- 人に返すのは、本人にしかできない操作だけ（OAuth 同意・ログイン・API キーの入力、顧客 AWS の管理者承認、業務ルールの確定、本番公開の承認）。接続テストが通れば作成作業は自動で再開する
- 承認の粒度は組織が選べる（個別承認／安全操作を自動承認／ポリシー内を自動承認／完全自律運転）。完全自律運転でも、秘密情報の登録・OAuth 同意・新しい接続先・権限拡大・予算上限の変更は自動化しない
- 完成条件は「コードを書いた」ではない。テストとセキュリティ検査が通り、版が固定され、Preview で最後まで動き、Tool 呼び出しと判断根拠が証跡に残って初めて完成とする

### ⑤ アイデア・独創性

**「AI に仕事を頼む」のではなく、「仕事をする AI」を AI に作らせる。**

- 自然言語 → Web アプリが Lovable なら、自然言語 → 業務 AI Agent が Agent Studio。既存の Agent Builder はプロンプトと Workflow を生成するところまでで、Tool と認証が足りない瞬間にエンジニアの出番になる。Agent Studio は、その「足りない部分を作る仕事」自体を Agent の仕事にした
- 出力が Agent 定義ではなく、**動く業務**であること。Backend Tool の実装・PR・マージ・顧客 AWS へのデプロイ・実行証跡までを1本につないでいる
- 作った Tool と Connector は社内の部品として残る。Agent を作るほど次の Agent が速くなり、企業ごとの資産が積み上がる
- 独創性の中心は「AI を賢くすること」ではなく「**AI を信用しすぎずに自律させること**」。鍵を渡さない、自己申告を検証する、判定はルール、最後は人が承認する——この分離のままで自律させる設計自体が、他の Agent Builder と分かれる点
- 題材も、AI に最も任せにくい業務（資料が多い・ブレが許されない・データを外に出せない・説明責任がある）を選び、そこで動くことを示した

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
│   ├── browser-session-worker/ # RunごとのChromium / Playwright Worker
│   ├── egress-proxy/       # Browser専用FQDN allowlist proxy
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

## CLI（画面操作なしで設定する）

連携サービスの接続、OAuth アプリの登録、貴社 AWS 用 Runtime、GitHub App の接続は、画面の代わりに `agent-studio` コマンドで行える。Builder が人の操作を待っているときは、作成状況カードと `agent-studio doctor` に実行すべきコマンドがそのまま出る。

```bash
yarn workspace @agent-studio/cli build
alias agent-studio="node $PWD/packages/cli/bin/agent-studio.js"

agent-studio login --dev owner@sample-a.example       # ローカル。本番は `agent-studio login` でブラウザが開く
agent-studio services                                 # 接続できるサービスと状態
echo "$NOTION_TOKEN" | agent-studio connect notion --secret-stdin   # API キー方式（値は引数に出さない）
agent-studio connect slack                            # OAuth 方式（ブラウザで許可するだけ）
agent-studio oauth-app set slack --client-id xxx --client-secret-env SLACK_CLIENT_SECRET   # オーナー、初回のみ
agent-studio runtime add --aws-account 123456789012 --region ap-northeast-1                 # 登録用トークンと aws コマンドを出力
agent-studio github connect --org my-company          # GitHub App を作成→インストール→接続（ブラウザで 2 回押すだけ）
agent-studio doctor                                   # 待ち中の操作と、解決するコマンド
```

- 秘密の値は `--secret-stdin`（標準入力）か `--secret-env VAR`（環境変数）でだけ渡す。シェル履歴に残らない。
- OAuth アプリの Redirect URI には、Web の `https://<公開ドメイン>/integrations/oauth/callback` と CLI の `http://127.0.0.1:48127/callback` の両方を登録する。
- 本番のブラウザログインには Cognito の CLI 用 app client（`COGNITO_DOMAIN` / `COGNITO_CLI_CLIENT_ID`、Terraform が作る）が必要。無い環境では `agent-studio login --token <IDトークン>` でも使える。

## テスト

```bash
yarn type-check
yarn test                                          # 単体テスト（全ワークスペース）
yarn workspace @agent-studio/api test:integration  # 結合テスト（PostgreSQL が必要）
```

結合テストはローカルの `.env` を読み、同じ PostgreSQL を使う。`yarn dev:worker` が起動中だと
テスト用の Run を開発 Worker が取得して競合するため、結合テストの間だけ Worker を停止する。

結合テストでは、組織の分離（RLS・複合外部キー・監査ログの追記のみ）と、実行の流れ（Runtime の登録、承認、後片付け）を確認する。

## CI/CD

| ワークフロー | いつ | 内容 |
|---|---|---|
| [ci.yml](.github/workflows/ci.yml) | PR・main への push | 型チェック、単体テスト、ビルド、マイグレーションと差分、結合テスト、Terraform の fmt/validate、イメージのビルド |
| [deploy-control-plane.yml](.github/workflows/deploy-control-plane.yml) | main への push（staging）・手動（production） | イメージの push → マイグレーション → ECS の更新 → ヘルスチェック |
| [deploy-runtime.yml](.github/workflows/deploy-runtime.yml) | main への push（staging）・手動（production） | Runtime のイメージの push → 企業ごとの Terraform の適用 |

AWS には GitHub OIDC で接続する（長期のアクセスキーは使わない）。AWS 側の準備と GitHub Environment の変数は [infra/README.md](infra/README.md)。
必須のAWS設定が不足している場合、main への push で起動した自動デプロイは warning を残してスキップする。手動で明示的に起動したデプロイは設定不足をエラーとして失敗終了する。

## ドキュメント

- [要件定義書](docs/requirements.md)
- [Agent Studio Builder Agent 要件定義書](docs/builder-agent-requirements.md)
- [Agent Builder 完成タスク仕様書](docs/builder-agent-completion-task-spec.md)
- [デプロイ契約（名前・環境変数・IAM）](docs/architecture/deployment-contract.md)
- [API 一覧](docs/architecture/api.md)
- [実装状況と残っている作業](docs/implementation-status.md)
- [OpenAI Agents API（SDK）の調査メモ](docs/reference/openai-agents-sdk.md)
