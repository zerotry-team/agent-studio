terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # bucket / key / region は CI が -backend-config で渡す（infra/README.md を参照）
  #   key = agent-studio/production/terraform.tfstate
  backend "s3" {
    use_lockfile = true
    encrypt      = true
  }
}
