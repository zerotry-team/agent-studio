# infra/bootstrap

AWS アカウントごとに **1 回だけ**、管理者が自分の認証情報で適用するルートモジュール。CI/CD（GitHub Actions）が使う次のものを作る。

| 作るもの | 名前 | 備考 |
|---|---|---|
| Terraform の state バケット | `as-tfstate-<account_id>-<region>` | バージョニング、SSE-KMS、パブリックアクセスのブロック、TLS 以外を拒否。ロックは S3 ネイティブ（`use_lockfile`）なので DynamoDB は不要 |
| GitHub Actions の OIDC プロバイダー | `token.actions.githubusercontent.com` | アカウントに既にある場合は `create_github_oidc_provider = false` |
| デプロイ用ロール | `as-github-deploy` | 信頼するのは `repo:<github_repository>:environment:<env>` だけ。権限は AdministratorAccess（理由は `github_oidc.tf` のコメント） |
| ECR リポジトリ 7 つ | `agent-studio/*` | `create_ecr_repositories = true` のとき（Agent Studio のアカウントだけ）。Runtime 用の 5 つはテナントのアカウントから pull できる |

## state の置き場所

このモジュールだけは state を **ローカル** に置く（state バケットをこのモジュール自身が作るため）。
1 つのディレクトリで複数のアカウントを扱うため、**アカウントごとに Terraform の workspace を分ける**。state は
`infra/bootstrap/terraform.tfstate.d/<workspace>/terraform.tfstate` にでき、`.gitignore` で除外されている。

- state にパスワードなどの秘密は含まれない（バケット・ロール・リポジトリの ID だけ）。
- なくした場合は `terraform import` で取り込み直せるが、チームの安全な保管場所（パスワードマネージャーなど）にコピーを置いておくとよい。

## 手順

前提: Terraform 1.11 以上、対象アカウントの管理者権限（例: IAM Identity Center の AdministratorAccess）。

```bash
cd infra/bootstrap

# 1. 対象アカウントにログインする
aws sso login --profile agent-studio-production-admin
export AWS_PROFILE=agent-studio-production-admin

# 2. 変数ファイルを作る（workspace 名と同じ名前にしておくと分かりやすい）
cp agent-studio.example.tfvars agent-studio-production.tfvars   # テナントなら tenant.example.tfvars をコピー
vi agent-studio-production.tfvars

# 3. アカウント用の workspace を作って適用する
terraform init
terraform workspace new agent-studio-production    # 2 回目以降は terraform workspace select agent-studio-production
terraform plan  -var-file=agent-studio-production.tfvars
terraform apply -var-file=agent-studio-production.tfvars

# 4. 出力を GitHub Environment の変数に設定する（infra/README.md を参照）
terraform output
```

アカウントごとの workspace 名と変数の例:

| アカウント | workspace | `create_ecr_repositories` | `github_environments` |
|---|---|---|---|
| agent-studio-staging | `agent-studio-staging` | `true` | `["agent-studio-staging"]` |
| agent-studio-production | `agent-studio-production` | `true` | `["agent-studio-production"]` |
| sample-a-company-prod | `sample-a-company-production` | `false` | `["company-sample-a-company-production"]` |
| sample-a-company-staging | `sample-a-company-staging` | `false` | `["company-sample-a-company-staging"]` |

## 出力

| 出力 | 使い道 |
|---|---|
| `state_bucket_name` | GitHub Environment の変数 `TF_STATE_BUCKET` |
| `deploy_role_arn` | GitHub Environment の変数 `AWS_DEPLOY_ROLE_ARN` |
| `ecr_registry` | Agent Studio のルートモジュールの `image_registry`、company 環境の変数 `IMAGE_REGISTRY` |

## テナントを追加したとき

テナントのアカウントが Runtime のイメージを pull できるように、**イメージを置いている Agent Studio のアカウント**の設定を確認する。

- 自社の Organizations 配下のアカウントで、`ecr_pull_organization_id` を設定済みなら作業は不要。
- 組織外（顧客所有）のアカウントは、`ecr_pull_account_ids` にアカウント ID を足して、そのアカウントの workspace でもう一度 `terraform apply` する。

## 注意

- GitHub の OIDC トークンの `sub` を組織でカスタマイズしている場合（`repo:...:environment:...` 以外の形式）は、信頼ポリシーの条件を合わせて直す。
- `github_environments` に入れた Environment には、GitHub 側で保護ルール（必須の承認者、デプロイできるブランチ）を必ず設定する。このロールはアカウントの管理者権限を持つ。
