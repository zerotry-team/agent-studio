# テナント Runtime（Execution Plane。docs/architecture/deployment-contract.md §5）

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition

  stage_short    = var.stage == "production" ? "prod" : "stg"
  prefix         = "as-${var.tenant_short}-${local.stage_short}"
  secrets_prefix = "agent-studio/runtime/${var.tenant_short}/${local.stage_short}"
  namespace      = "${local.prefix}.internal"

  gateway_url       = "http://gateway.${local.namespace}:8080/mcp"
  agent_studio_host = regex("^https://([^/:]+)", var.agent_studio_url)[0]

  # 初回（イメージがまだ無い）はサービスを起動しない
  services_enabled = var.image_tag != "none"

  # demo-internal-api は connections/demo-internal-api のトークンを使うため、有効なら必ず作る
  connection_names = distinct(concat(
    var.connections,
    var.demo_internal_api_enabled ? ["demo-internal-api"] : [],
  ))

  # jsonencode は < と > を < / > にエスケープするため、エスケープ後の形で置き換える
  tool_config_json  = replace(jsonencode(var.tool_config), "\\u003cprefix\\u003e", local.prefix)
  tool_config_bytes = floor(length(base64encode(local.tool_config_json)) * 3 / 4)

  ecr_registry_parts = regex("^([0-9]{12})\\.dkr\\.ecr\\.([a-z0-9-]+)\\.amazonaws\\.com$", var.image_registry)
  ecr_repository_arn = {
    for repo in ["runtime-controller", "tool-gateway", "session-worker", "browser-worker", "demo-internal-api"] :
    repo => "arn:${local.partition}:ecr:${local.ecr_registry_parts[1]}:${local.ecr_registry_parts[0]}:repository/agent-studio/${repo}"
  }
  image = {
    for repo in keys(local.ecr_repository_arn) : repo => "${var.image_registry}/agent-studio/${repo}:${var.image_tag}"
  }
}

module "network" {
  source = "../network"

  name              = local.prefix
  cidr_block        = var.vpc_cidr
  az_count          = 2
  nat_gateway_count = var.nat_gateway_count
}

# Tool Gateway のツール設定（RuntimeToolConfig の JSON）。Tool Gateway が起動時に読む
resource "aws_ssm_parameter" "tool_config" {
  name        = "/${local.prefix}/tool-config"
  description = "Tool Gateway のツール設定（infra/company/<tenant>/config.yaml の runtime.tools）"
  type        = "String"
  tier        = local.tool_config_bytes > 4096 ? "Advanced" : "Standard"
  value       = local.tool_config_json

  lifecycle {
    precondition {
      condition     = local.tool_config_bytes <= 8192
      error_message = "tool_config が大きすぎます（SSM パラメータの上限 8KB）。"
    }
  }
}
