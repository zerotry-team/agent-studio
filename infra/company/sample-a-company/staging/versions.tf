terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # bucket / key / region は CI が -backend-config で渡す（infra/README.md を参照）
  #   bucket = テナントのアカウントの as-tfstate-<account_id>-<region>
  #   key    = company/sample-a-company/staging/terraform.tfstate
  backend "s3" {
    use_lockfile = true
    encrypt      = true
  }
}
