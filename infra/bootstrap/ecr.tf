# コンテナイメージのリポジトリ（Agent Studio の各環境アカウントだけに作る）

locals {
  ecr_repositories = var.create_ecr_repositories ? toset([
    "agent-studio/api",
    "agent-studio/web",
    "agent-studio/runtime-controller",
    "agent-studio/tool-gateway",
    "agent-studio/session-worker",
    "agent-studio/browser-worker",
    "agent-studio/demo-internal-api",
  ]) : toset([])

  # テナントのアカウントから pull されるリポジトリ
  runtime_repositories = toset([
    for r in local.ecr_repositories : r if r != "agent-studio/api" && r != "agent-studio/web"
  ])

  ecr_cross_account_pull_enabled = var.ecr_pull_organization_id != "" || length(var.ecr_pull_account_ids) > 0

  ecr_registry = "${local.account_id}.dkr.ecr.${var.region}.amazonaws.com"
}

resource "aws_ecr_repository" "this" {
  for_each = local.ecr_repositories

  name = each.value
  # タグは commit SHA だが、同じ SHA の再ビルド・再 push を許すため MUTABLE にする
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each = aws_ecr_repository.this

  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "直近 ${var.ecr_image_retention_count} 個のイメージだけ残す"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = var.ecr_image_retention_count
      }
      action = { type = "expire" }
    }]
  })
}

data "aws_iam_policy_document" "ecr_cross_account_pull" {
  count = local.ecr_cross_account_pull_enabled ? 1 : 0

  dynamic "statement" {
    for_each = var.ecr_pull_organization_id != "" ? [1] : []
    content {
      sid = "PullFromOrganization"
      actions = [
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
      ]
      principals {
        type        = "*"
        identifiers = ["*"]
      }
      condition {
        test     = "StringEquals"
        variable = "aws:PrincipalOrgID"
        values   = [var.ecr_pull_organization_id]
      }
    }
  }

  dynamic "statement" {
    for_each = length(var.ecr_pull_account_ids) > 0 ? [1] : []
    content {
      sid = "PullFromAccounts"
      actions = [
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
      ]
      principals {
        type        = "AWS"
        identifiers = [for id in var.ecr_pull_account_ids : "arn:${data.aws_partition.current.partition}:iam::${id}:root"]
      }
    }
  }
}

resource "aws_ecr_repository_policy" "runtime" {
  for_each = local.ecr_cross_account_pull_enabled ? local.runtime_repositories : toset([])

  repository = aws_ecr_repository.this[each.value].name
  policy     = data.aws_iam_policy_document.ecr_cross_account_pull[0].json
}
