terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  backend "s3" {
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.target_account_id]

  assume_role {
    role_arn     = "arn:aws:iam::${var.target_account_id}:role/OrganizationAccountAccessRole"
    session_name = "agent-studio-managed-runtime"
  }

  default_tags {
    tags = {
      "agentstudio:organization_id" = var.organization_id
      "agentstudio:runtime_id"      = var.runtime_id
      "agentstudio:environment"     = "${var.tenant_short}-${var.stage}"
      "ManagedBy"                   = "agent-studio"
    }
  }
}
