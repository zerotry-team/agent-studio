# infra

Agent Studio の AWS 構成（Terraform）。名前・ポート・環境変数・IAM は `docs/architecture/deployment-contract.md`（デプロイ契約）に合わせている。
契約を変えるときは、アプリ・Runtime・CI/CD と一緒にここも直す。

## ディレクトリ

```text
infra/
├── organization/              # AWS Organizations でアカウントを作る（管理アカウントで 1 回）
├── bootstrap/                 # アカウントごとに 1 回、管理者が適用（state バケット、GitHub OIDC、デプロイ用ロール、ECR、GitHub Environment）
├── modules/
│   ├── network/               # VPC（public / private / database サブネット、NAT、S3 ゲートウェイエンドポイント）
│   ├── ecs-execution-role/    # ECS の実行ロール（ECR・ログ・注入するシークレットを ARN で限定）
│   ├── control-plane/         # Agent Studio 本体（契約 §4）
│   └── tenant-runtime/        # テナント Runtime（契約 §5）
├── agent-studio/
│   ├── staging/               # ルートモジュール（control-plane を呼ぶ）
│   └── production/
└── company/
    ├── README.md              # テナントの追加手順
    └── sample-a-company/
        ├── config.yaml        # テナントの設定
        ├── staging/           # ルートモジュール（tenant-runtime を呼ぶ）
        └── production/
```

| ルートモジュール | state のキー | GitHub Environment |
|---|---|---|
| `bootstrap` | ローカル（workspace ごと） | なし（管理者が手元で適用） |
| `agent-studio/staging` | `agent-studio/staging/terraform.tfstate` | `agent-studio-staging` |
| `agent-studio/production` | `agent-studio/production/terraform.tfstate` | `agent-studio-production` |
| `company/<slug>/<stage>` | `company/<slug>/<stage>/terraform.tfstate` | `company-<slug>-<stage>` |

state は各アカウントの `as-tfstate-<account_id>-<region>` バケットに置く（Agent Studio とテナントでアカウントが違うため、バケットも別）。

- Terraform 1.11 以上（S3 のネイティブロック `use_lockfile` を使う）
- プロバイダー: `hashicorp/aws ~> 6.0`、`hashicorp/random ~> 3.6`。`.terraform.lock.hcl` はコミットする

## 初めて構築するときの順番

1. **アカウントを用意する**: `infra/organization` で Terraform から作る（infra/organization/README.md）。`agent-studio-staging`、`agent-studio-production`、テナントごとのアカウント（要件定義書 §12.1）
2. **各アカウントを bootstrap する**（管理者。`bootstrap/README.md`）
   - Agent Studio のアカウント: `create_ecr_repositories = true`。テナントに pull させるなら `ecr_pull_organization_id` / `ecr_pull_account_ids`
   - テナントのアカウント: `create_ecr_repositories = false`
3. **GitHub Environment を作り、変数（vars）を設定する**（下の表）。保護ルール（承認者、デプロイできるブランチ）も設定する
4. **CI/CD で Agent Studio を適用する**（staging → production）。初回は `image_tag = "none"` でサービスを起動せずに基盤だけ作り、
   続けてマイグレーション → サービス起動の順で進む（下の「Agent Studio のデプロイの流れ」）
5. **手作業の設定をする**（下の「手作業で行うこと」）
6. **テナントを追加する**（`company/README.md`）

### GitHub Environment の変数

| 変数 | 値 | 使う Environment |
|---|---|---|
| `AWS_REGION` | `ap-northeast-1` | すべて |
| `AWS_ACCOUNT_ID` | 適用先のアカウント ID | すべて |
| `AWS_DEPLOY_ROLE_ARN` | bootstrap の出力 `deploy_role_arn` | すべて |
| `TF_STATE_BUCKET` | bootstrap の出力 `state_bucket_name` | すべて |
| `IMAGE_REGISTRY` | Agent Studio 側の bootstrap の出力 `ecr_registry` | `company-*` |

## CI からの Terraform の実行

バックエンドは部分設定（`backend "s3" { use_lockfile = true }`）なので、bucket / key / region は `-backend-config` で渡す。

```bash
# Agent Studio（例: staging）
ROOT=infra/agent-studio/staging
terraform -chdir=$ROOT init -input=false \
  -backend-config="bucket=${TF_STATE_BUCKET}" \
  -backend-config="key=agent-studio/staging/terraform.tfstate" \
  -backend-config="region=${AWS_REGION}"
terraform -chdir=$ROOT apply -input=false -auto-approve \
  -var="aws_account_id=${AWS_ACCOUNT_ID}" \
  -var="image_registry=${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com" \
  -var="image_tag=${IMAGE_TAG}" \
  -var="migrate_image_tag=${MIGRATE_IMAGE_TAG}"

# テナント（例: sample-a-company の production）
ROOT=infra/company/sample-a-company/production
terraform -chdir=$ROOT init -input=false \
  -backend-config="bucket=${TF_STATE_BUCKET}" \
  -backend-config="key=company/sample-a-company/production/terraform.tfstate" \
  -backend-config="region=${AWS_REGION}"
terraform -chdir=$ROOT apply -input=false -auto-approve \
  -var="image_registry=${IMAGE_REGISTRY}" \
  -var="image_tag=${GITHUB_SHA}"
```

### Agent Studio のデプロイの流れ

`image_tag`（api / worker / web）と `migrate_image_tag`（migrate）を分けているのは、**サービスを新しいイメージにする前にマイグレーションを流す**ため。

1. イメージをビルドして ECR に push する（タグ = commit SHA）
2. 今のタグを読む: `aws ssm get-parameter --name /as/<env>/deployed-image-tag --query Parameter.Value --output text`（初回は `none`）
3. `terraform apply -var image_tag=<今のタグ> -var migrate_image_tag=<新しい SHA>`（migrate のタスク定義だけが新しくなる）
4. マイグレーションを実行して終了を待つ（出力 `cluster_name`、`migrate_task_definition_family`、`private_subnet_ids`、`migrate_security_group_id` を使う）
   ```bash
   aws ecs run-task --cluster "$CLUSTER" --task-definition "$MIGRATE_FAMILY" --launch-type FARGATE \
     --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$MIGRATE_SG],assignPublicIp=DISABLED}"
   aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"
   # コンテナ api の exitCode が 0 であることを確認する
   ```
5. `terraform apply -var image_tag=<新しい SHA> -var migrate_image_tag=<新しい SHA>`
6. `aws ecs wait services-stable --cluster "$CLUSTER" --services "$API" "$WORKER" "$WEB"`
7. `aws ssm put-parameter --name /as/<env>/deployed-image-tag --value <新しい SHA> --overwrite`

`image_tag = "none"` のときは api / worker / web の台数が 0 になる（初回、マイグレーション前にサービスを起動しないため）。

### Terraform の出力（CI/CD が使う名前）

`agent-studio/<env>`: `public_url`、`cluster_name`、`api_service_name`、`worker_service_name`、`web_service_name`、
`migrate_task_definition_family`、`migrate_security_group_id`、`private_subnet_ids`、`cognito_user_pool_id`、`cognito_client_id`、
`cognito_domain`、`runtime_server_id`、`artifacts_bucket`、`audit_bucket`、`deployed_image_tag_parameter`

`company/<slug>/<stage>`: `runtime_role_name`、`runtime_role_arn`、`aws_account_id`、`gateway_url`、`cluster_name`、
`runtime_core_service_name`、`tool_config_parameter`、`bootstrap_token_secret_id`、`connection_secret_ids`、`next_steps`

## 手作業で行うこと

Terraform では値を持たない（持たせない）ものは、運用者が設定する。

| 作業 | いつ | 方法 |
|---|---|---|
| Anthropic の API キー | Agent Studio の初回適用後 | `aws secretsmanager put-secret-value --secret-id as-<env>/anthropic-api-key --secret-string "$KEY"` のあと、api / worker を `aws ecs update-service --force-new-deployment` で再起動する。未設定の間は値が `unset` |
| 最初の管理者ユーザー | Agent Studio の初回適用後 | 自己登録は無効なので、`aws cognito-idp admin-create-user --user-pool-id <cognito_user_pool_id> --username <メール> --user-attributes Name=email,Value=<メール> Name=email_verified,Value=true` で招待する |
| 組織ごとの OpenAI のキー | 組織の作成時 | Agent Studio の画面から登録する（アプリが `agent-studio/<env>/orgs/<organization_id>/...` に保存する） |
| 独自ドメインの DNS | `domain_name` を使う場合 | `domain_name` を出力 `cloudfront_domain_name` に向ける（ALIAS / CNAME）。証明書は us-east-1 の ACM で事前に発行する |
| Runtime の Bootstrap Token | テナントの適用後 | 出力 `next_steps` のとおり。Agent Studio で Runtime を登録 → 発行されたトークンを `put-secret-value` → Controller を再起動 |
| 業務システムの認証情報 | テナントの適用後 | 出力 `next_steps` のとおり `connections/<名前>` に値を入れる |
| Runtime のイメージの pull 許可 | 組織外のテナントを追加したとき | Agent Studio 側の bootstrap の `ecr_pull_account_ids` に追加して適用 |

## 設計上の注意

- **CloudFront → ALB**: ALB の SG は CloudFront の origin-facing プレフィックスリストだけを許可し、さらにヘッダ `X-Origin-Verify`（Secrets Manager `as-<env>/origin-verify`）が一致しない要求は 403 にする。既定では CloudFront → ALB は HTTP なので、本番では `domain_name` と `alb_certificate_arn`（ap-northeast-1 の ACM、`domain_name` を含む証明書）を指定して HTTPS にすることを勧める。
- **long-poll**: CloudFront のオリジン応答待ちは 60 秒（`cloudfront_origin_read_timeout`）。Runtime の long-poll の待ち時間はこれより短くする。
- **WAF**: AWS マネージドルールの `SizeRestrictions_BODY`（本文 8KB 超）は記録だけにしている（Manifest の保存などで超えるため）。
- **Cognito のメール**: 既定の Cognito のメール送信は 1 日の上限が小さい。本番で招待が増えたら SES に切り替える。
- **DB の TLS**: RDS は `rds.force_ssl = 1`。アプリは SSL で接続する。
- **テナントの DNS Firewall**: VPC 内のすべての名前解決が許可リスト方式になる。Tool Gateway が名前で呼ぶ社内システムや、Browser Worker で開くサイトは `config.yaml` の `extra_allowed_domains` に入れる。
- **シークレットの値と state**: Terraform が生成するパスワード（`db-app` など）は state にも入る。state バケットは暗号化・非公開・TLS のみ。
