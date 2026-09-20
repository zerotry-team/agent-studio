# ファクタリング審査デモのデータ

買取申込の審査をエージェントに試させるための、架空の業務データと、それを返す基幹システムのモックです。
エージェントは**読むだけ**で、このデータを書き換えません。

- データの定義: [db/schema.sql](db/schema.sql)
- データの中身: [db/seed.sql](db/seed.sql)
- API: [src/app.ts](src/app.ts)（既定 8091 番）
- 投入スクリプト: [src/load.ts](src/load.ts)

## 1. どんなデータか

事業者・請求書・入金はすべて架空です。売掛先の「トヨタ自動車株式会社」だけは、国税庁法人番号公表サイトで
実在確認が通ることを確かめるための実在商号で、法人番号と所在地は同サイトの公開データです。
請求書の中身は架空で、実際の取引とは関係ありません。

| テーブル | 中身 | 件数 |
|---|---|---|
| `applicants` | 申込者（事業者名・代表者・所在地・業種・設立日・年商・従業員数・申込日） | 3 |
| `counterparties` | 売掛先（商号・所在地・法人番号／申込書に記載が無いものは NULL） | 3 |
| `invoices` | 買取申込の請求書（請求額・発行日・支払期日・支払条件・状態） | 5 |
| `payment_records` | 売掛先からの過去の入金実績（期日・実入金日・金額） | 11 |
| `screenings` | 審査結果の書き戻し用。**読むだけの構成では使わない** | 0 |

### 4 件が別々の結論になる

審査待ち（`status = 申込中`）は 4 件です。それぞれ違う結論に着地するように作ってあります。

| 申込 | 申込者 → 売掛先 | 金額 | 仕込み | 想定 |
|---|---|---|---|---|
| INV-2026-0101 | みなと製作所 → トヨタ自動車 | 1,850 万 | 法人番号・所在地が公表データと一致。過去 4 回すべて期日内入金 | 可 |
| INV-2026-0104 | みなと製作所 → さかえ流通 | 430 万 | 数日遅れるが入金実績あり。金額も小さい | 可 |
| INV-2026-0102 | サンライズ物流 → さかえ流通 | 620 万 | 売掛先が公表データに無い。入金は 22 日・27 日遅れ、直近は未入金 | 保留 |
| INV-2026-0103 | ひばりデザイン → アオゾラ | 135 万 | 支払期日を超過。**同じ請求書番号で 7 月にも申込**（INV-2026-0087、取下げ） | 否 |

INV-2026-0087 は二重譲渡の手がかりです。`GET /applications/INV-2026-0103` の `same_invoice_number` に出てきます。

### 実在確認のしかた

国税庁法人番号公表サイト（`https://www.houjin-bangou.nta.go.jp/`）で引きます。3 社とも実際に確かめた結果です。

| 売掛先 | 申込書の法人番号 | サイトで引いた結果 |
|---|---|---|
| トヨタ自動車株式会社 | 1180301018771 | 一致（愛知県豊田市トヨタ町１番地） |
| 株式会社さかえ流通 | 9010001000001 | 該当なし。この番号はチェックディジットも合わない架空の値 |
| 合同会社アオゾラワークス | 記載なし | 該当なし |

**既定の「部分一致検索」だとトヨタは系列会社が 23 件出て、目的の 1 件が 1 ページ目に入りません。**
「前方一致検索」を選ぶと 1 件に絞れます。エージェントの指示文に書いておくこと。

```
1. https://www.houjin-bangou.nta.go.jp/ を開く   browser_navigate
2. 「前方一致検索」を選ぶ                        browser_click  { text: "前方一致検索" }
3. 商号を入れる                                  browser_type   { selector: "#corp_name", value: "<商号>" }
4. 検索する                                      browser_click  { selector: "#search_condition" }
5. 結果を読む                                    browser_snapshot
```

`browser_type` と `browser_click` はリスク区分が `write` なので、POL-07（外部の内容を読むエージェントは更新系の操作を承認制にする）
により**承認待ちで 1 回止まります**。想定どおりの挙動です。

## 2. どこに置くか

業務データなので **Agent Studio の DB には入れません**（CLAUDE.md「組織の分離」）。
Agent Studio の DB はエージェント・Run・ツールのためのもので、顧客の業務データを持たない前提です。

| | 置き場 | 備考 |
|---|---|---|
| ローカル | PostgreSQL の `factoring_demo` データベース | `docker compose` の Postgres（5434 番）に相乗り |
| 本番（AWS） | Runtime 側に用意した PostgreSQL | **現時点では存在しない。3 章の前提作業が要る** |

## 3. ローカルに入れる

初回だけデータベースを作ります。

```bash
docker exec agent-studio-postgres-1 createdb -U postgres factoring_demo
```

投入します（`schema.sql` は既存テーブルを落として作り直します）。

```bash
yarn workspace @agent-studio/demo-factoring-api db:load
```

データだけ入れ直すときは `db:load:seed-only`。接続先は `FACTORING_DATABASE_URL`（既定
`postgresql://postgres:postgres@localhost:5434/factoring_demo`）で変えられます。

確認：

```bash
curl -s -H "Authorization: Bearer local-factoring-token" localhost:8091/applications
```

## 4. 本番に入れる

### 前提（まだ無いもの）

本番の Runtime には DB がありません。次の 3 つが先に要ります。

1. **PostgreSQL を用意する。** `infra/modules/tenant-runtime` に RDS を足し、接続情報を Secrets Manager に置く。
   デモ用途なら最小構成（db.t4g.micro、シングル AZ、パブリックアクセス無効）で足ります
2. **イメージに `db/` を含める。** `runtime/demo-factoring-api/Dockerfile` を作るとき、`dist/` だけでなく
   `db/schema.sql` と `db/seed.sql` もコピーする。投入スクリプトが実行時に読むため
3. **投入用のタスク定義を足す。** Agent Studio の `migrate` タスクと同じ形（サービスを作らず、CI/CD が `run-task` する）。
   コマンドは `node dist/load.js`、`FACTORING_DATABASE_URL` を Secrets Manager から渡す

### 手順

RDS はプライベートサブネットにいるので、**手元から `psql` でつなぐ経路はありません**。
Agent Studio の DB マイグレーションと同じく、一回限りの ECS タスクで流します（`infra/README.md` の
「Agent Studio のデプロイの流れ」手順 4 と同じ形）。

```bash
# Terraform の出力から
CLUSTER=$(terraform -chdir=$ROOT output -raw cluster_name)
SUBNETS=$(terraform -chdir=$ROOT output -json private_subnet_ids | jq -r 'join(",")')
SG=$(terraform -chdir=$ROOT output -raw factoring_loader_security_group_id)
FAMILY=$(terraform -chdir=$ROOT output -raw factoring_loader_task_definition_family)

# 投入（--seed-only を付けるとテーブルを作り直さずデータだけ入れ替える）
TASK_ARN=$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$FAMILY" --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=DISABLED}" \
  --query 'tasks[0].taskArn' --output text)

aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"
aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[0].exitCode'   # 0 であること
```

ログは CloudWatch Logs に `デモデータを投入しました applicants=3 invoices=5 payments=11` が出ます。

確認は、Runtime 内から API を叩くか、Agent Studio でエージェントを 1 回走らせるのが早いです。

### 入れ直し

`seed.sql` の先頭で `TRUNCATE ... RESTART IDENTITY CASCADE` しているので、何度流しても同じ状態になります。
デモの前に `--seed-only` で 1 回流しておけば、前回の Run で汚れていても元に戻ります。

### やらないこと

- **Terraform にデータを書かない。** tfstate に申込者の氏名・住所・金額が平文で残ります。
  Terraform が作るのは DB インスタンスまで。中身は投入タスクの仕事です
- **踏み台を立てて手で `psql` しない。** 手順が再現できず、誰が何を入れたか残りません
- **Agent Studio の RDS に入れない。** 業務データを Control Plane に置かない前提が崩れます

## 5. 実データに切り替えるとき

顧客の実システムを使うなら、**このデータもこの API も本番には出しません**。
[tool-config](../tool-gateway/examples/tool-config.local.yaml) のツール定義をコピーして、
`infra/company/<tenant>/config.yaml` の `runtime.tools` に URL を実システム向けで書くだけです。

```yaml
http:
  url: "http://factoring-core.customer.internal/applications/{invoice_id}"
  auth: { type: bearer, secret: factoring-core }
```

ツール名と入力スキーマを同じにしておけば、**エージェントは変更なしで実データを見に行きます**。
返る JSON の形が違う場合は、モック側を実システムに合わせるか、エージェントの指示文で吸収します。

あわせて、ブラウザの通信許可を 3 か所そろえる必要があります（ローカルでは 1 か所だけでした）。

```
Agent の Variables（BROWSER_ALLOWED_DOMAINS）      Run ごとの許可
  ↓
config.yaml の egress_policy.allowed_domains      Egress Proxy
  ↓
config.yaml の extra_allowed_domains              DNS Firewall
```

実在確認をするなら `houjin-bangou.nta.go.jp` を下 2 つにも入れます。入れ忘れると本番でだけ静かに失敗します。
