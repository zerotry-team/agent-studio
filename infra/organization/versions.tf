# AWS Organizations の管理アカウントで、管理者が 1 回だけ適用する（README.md）。
# state はローカル（terraform.tfstate。.gitignore で除外）。

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
  allowed_account_ids = [var.management_account_id]

  default_tags {
    tags = {
      "agentstudio:component" = "organization"
      "ManagedBy"             = "terraform"
    }
  }
}
