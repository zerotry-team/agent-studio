provider "aws" {
  region              = local.config.region
  allowed_account_ids = local.aws_account_id != "" ? [local.aws_account_id] : null

  default_tags {
    tags = {
      "agentstudio:component"       = "tenant-runtime"
      "agentstudio:environment"     = local.stage
      "agentstudio:organization_id" = local.organization_id
      # 登録前は Runtime ID が無いため unregistered にする
      "agentstudio:runtime_id" = local.runtime_id != "" ? local.runtime_id : "unregistered"
      "agentstudio:tenant"     = local.config.slug
      "ManagedBy"              = "terraform"
    }
  }
}
