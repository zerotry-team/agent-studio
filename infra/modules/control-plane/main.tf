# Agent Studio の Control Plane（docs/architecture/deployment-contract.md §4）

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

data "aws_partition" "current" {}

locals {
  name       = "as-${var.environment}"
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region
  partition  = data.aws_partition.current.partition

  # 初回デプロイ（マイグレーション前）はサービスを起動しない
  services_enabled = var.image_tag != "none"

  public_host = var.domain_name != "" ? var.domain_name : aws_cloudfront_distribution.this.domain_name
  public_url  = "https://${local.public_host}"

  runtime_server_id = "agent-studio-${var.environment}"
  # 組織ごとの OpenAI キーはアプリがこの接頭辞の下に作る
  org_secrets_prefix = "agent-studio/${var.environment}"

  db_name     = "agent_studio"
  db_app_user = "agent_studio_app"

  ecr_registry_parts = regex("^([0-9]{12})\\.dkr\\.ecr\\.([a-z0-9-]+)\\.amazonaws\\.com$", var.image_registry)
  ecr_repository_arn = {
    for repo in ["api", "web"] :
    repo => "arn:${local.partition}:ecr:${local.ecr_registry_parts[1]}:${local.ecr_registry_parts[0]}:repository/agent-studio/${repo}"
  }

  api_image     = "${var.image_registry}/agent-studio/api:${var.image_tag}"
  migrate_image = "${var.image_registry}/agent-studio/api:${var.migrate_image_tag}"
  web_image     = "${var.image_registry}/agent-studio/web:${var.image_tag}"
}

module "network" {
  source = "../network"

  name                    = local.name
  cidr_block              = var.vpc_cidr
  az_count                = 2
  nat_gateway_count       = var.nat_gateway_count
  create_database_subnets = true
}

resource "aws_ssm_parameter" "deployed_image_tag" {
  name        = "/as/${var.environment}/deployed-image-tag"
  description = "Image tag of api/worker/web currently deployed (written by CI/CD)"
  type        = "String"
  value       = "none"

  lifecycle {
    ignore_changes = [value]
  }
}
