# AWS アカウントごとに 1 回だけ、管理者が自分の認証情報で適用する。
# state はローカル（workspace をアカウントごとに分ける）。手順は README.md を参照。

terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      "agentstudio:component"   = "bootstrap"
      "agentstudio:environment" = var.environment
      "ManagedBy"               = "terraform"
    }
  }
}
