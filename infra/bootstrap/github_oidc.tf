# GitHub Actions から OIDC でデプロイ用ロールを引き受けられるようにする

locals {
  github_oidc_host = "token.actions.githubusercontent.com"
}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 1 : 0

  url            = "https://${local.github_oidc_host}"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 0 : 1

  url = "https://${local.github_oidc_host}"
}

locals {
  github_oidc_provider_arn = var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn
}

# 信頼するのは「指定したリポジトリの、指定した GitHub Environment で動くジョブ」だけ。
# ブランチや pull_request のトークンでは引き受けられない（sub が environment: で始まらないため）。
# Environment 側で保護ルール（承認者・デプロイ可能なブランチ）を設定して使う。
data "aws_iam_policy_document" "github_deploy_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_host}:sub"
      values   = [for env in var.github_environments : "repo:${var.github_repository}:environment:${env}"]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name                 = var.deploy_role_name
  description          = "Used by GitHub Actions (${var.github_repository}) to apply Terraform and deploy"
  assume_role_policy   = data.aws_iam_policy_document.github_deploy_assume.json
  max_session_duration = 3600
}

# AdministratorAccess を付ける理由:
# このロールは Terraform で VPC・IAM ロール・KMS・RDS・CloudFront・WAF などアカウント内のほぼ全種類の
# リソースを作成・変更する。IAM ロールを作れる時点で実質的に管理者と同じ権限になるため、
# 細かく絞っても安全性はほとんど上がらず、リソースを追加するたびに適用が失敗する原因になる。
# その代わりに、引き受けられる主体を上の信頼ポリシーで「特定リポジトリの特定 Environment」だけに絞り、
# GitHub Environment の保護ルールで実行できる人・ブランチを制限する。
resource "aws_iam_role_policy_attachment" "github_deploy_admin" {
  role       = aws_iam_role.github_deploy.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AdministratorAccess"
}
