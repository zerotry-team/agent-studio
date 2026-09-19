# AWS アカウントごとに 1 回だけ、管理者が自分の認証情報で適用する。
# state はローカル（workspace をアカウントごとに分ける）。手順は README.md を参照。

terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.aws_account_id]

  # infra/organization で作ったアカウントは、管理アカウントの認証情報のまま OrganizationAccountAccessRole を引き受けて適用する
  dynamic "assume_role" {
    for_each = var.assume_role_arn != "" ? [1] : []
    content {
      role_arn     = var.assume_role_arn
      session_name = "agent-studio-bootstrap"
    }
  }

  default_tags {
    tags = {
      "agentstudio:component"   = "bootstrap"
      "agentstudio:environment" = var.environment
      "ManagedBy"               = "terraform"
    }
  }
}

# GitHub Environment と変数（manage_github_environments = true のとき）。
# トークンは環境変数 GITHUB_TOKEN（例: export GITHUB_TOKEN=$(gh auth token)）
provider "github" {
  owner = split("/", var.github_repository)[0]
}
