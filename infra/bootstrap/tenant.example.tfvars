# テナント（企業 × ステージ）のアカウント用の例。ECR は作らない（Agent Studio 側の ECR から pull する）。

aws_account_id    = "222222222222"
environment       = "sample-a-company-production"
github_repository = "zerotry/agent-studio"
github_environments = [
  "company-sample-a-company-production",
]

create_ecr_repositories = false
