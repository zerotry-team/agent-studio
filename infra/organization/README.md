# infra/organization

AWS Organizations の **管理アカウント** で、Agent Studio 用のアカウントを Terraform で作る。
作ったアカウントの初期設定（infra/bootstrap）も、管理アカウントの認証情報のまま行える（各アカウントの
`OrganizationAccountAccessRole` を引き受ける）。アカウントごとに IAM ユーザーやアクセスキーを作る必要はない。

## 全体の流れ（production の例）

| # | 作業 | 実行する人 | 使う認証情報 |
|---|---|---|---|
| 1 | 管理アカウントの管理者の認証情報をこの Mac に設定する | 利用者 | — |
| 2 | `infra/organization` を適用してアカウントを作る | 利用者（アカウントの作成は取り消せないため） | 管理アカウント |
| 3 | `infra/bootstrap` を Agent Studio のアカウントに適用する（GitHub Environment も作る） | 誰でも | 管理アカウント → OrganizationAccountAccessRole |
| 4 | `infra/bootstrap` を Sample A 社のアカウントに適用する | 誰でも | 同上 |
| 5 | GitHub Actions でデプロイする（Deploy Agent Studio → Deploy Company Runtime） | 誰でも | GitHub OIDC |

## 1. 管理アカウントの認証情報

管理アカウント（請求をまとめるアカウント）の管理者の認証情報を、プロファイル `agent-studio-management` として設定する。

```bash
aws configure --profile agent-studio-management     # アクセスキーの場合
aws configure sso                                    # IAM Identity Center の場合
```

## 2. アカウントを作る

```bash
cd infra/organization
cp example.tfvars terraform.tfvars     # 管理アカウントの ID と、新しいアカウントのメールアドレスを書く
export AWS_PROFILE=agent-studio-management
terraform init
terraform apply
terraform output -json > ../bootstrap/organization-output.json   # 3 と 4 で使う（.gitignore 済み）
```

- アカウントの作成には数分かかる。メールアドレスはアカウントごとに別のものにする（`aws+名前@ドメイン` の形が便利）。
- すでに Organizations を使っている管理アカウントなら `create_organization = false`。
- Terraform からアカウントは削除しない（`prevent_destroy`、`close_on_deletion = false`）。閉じるときは AWS の画面で行う。
- Companies OU には SCP（リージョンの制限、CloudTrail の停止・組織からの離脱の禁止）を付ける。

## 3〜4. 各アカウントの初期設定

infra/bootstrap/README.md の「Organizations で作ったアカウント」を参照。
