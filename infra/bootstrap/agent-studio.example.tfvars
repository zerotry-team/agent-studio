# Agent Studio の環境アカウント（staging / production）用の例。
# コピーして <workspace 名>.tfvars にし、値を書き換えて使う（README.md を参照）。

aws_account_id    = "111111111111"
environment       = "production"
github_repository = "zerotry-team/agent-studio"
github_environments = [
  "agent-studio-production",
]

create_ecr_repositories = true

# テナントのアカウントから Runtime のイメージを pull できるようにする
ecr_pull_organization_id = "" # 例: "o-abcdefghij"（Organizations 配下のテナント）
ecr_pull_account_ids     = [] # 例: ["222222222222"]（組織外の顧客アカウント）
