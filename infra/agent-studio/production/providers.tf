locals {
  environment = "production"

  default_tags = {
    "agentstudio:component"   = "control-plane"
    "agentstudio:environment" = local.environment
    "ManagedBy"               = "terraform"
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = var.aws_account_id != "" ? [var.aws_account_id] : null

  default_tags {
    tags = local.default_tags
  }
}

# CloudFront 用の WAF（と証明書）は us-east-1
provider "aws" {
  alias               = "us_east_1"
  region              = "us-east-1"
  allowed_account_ids = var.aws_account_id != "" ? [var.aws_account_id] : null

  default_tags {
    tags = local.default_tags
  }
}
