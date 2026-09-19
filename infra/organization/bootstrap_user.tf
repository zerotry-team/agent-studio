# infra/bootstrap の適用に使う IAM ユーザー（create_bootstrap_user = true のときだけ）。
# ルートユーザーは AssumeRole できないため、作成したアカウントの OrganizationAccountAccessRole を
# 引き受けることだけを許可したユーザーを用意する。管理アカウントそのものの操作はできない。
# アクセスキーはローカルの state にだけ残る。初期設定が終わったら create_bootstrap_user = false で削除する。

resource "aws_iam_user" "bootstrap" {
  count = var.create_bootstrap_user ? 1 : 0

  name = "agent-studio-bootstrap"
  path = "/agent-studio/"
}

data "aws_iam_policy_document" "bootstrap" {
  statement {
    sid       = "AssumeCreatedAccountsAdminRole"
    actions   = ["sts:AssumeRole"]
    resources = [for a in aws_organizations_account.this : "arn:aws:iam::${a.id}:role/OrganizationAccountAccessRole"]
  }
}

resource "aws_iam_user_policy" "bootstrap" {
  count = var.create_bootstrap_user ? 1 : 0

  name   = "assume-created-accounts"
  user   = aws_iam_user.bootstrap[0].name
  policy = data.aws_iam_policy_document.bootstrap.json
}

resource "aws_iam_access_key" "bootstrap" {
  count = var.create_bootstrap_user ? 1 : 0

  user = aws_iam_user.bootstrap[0].name
}

output "bootstrap_access_key_id" {
  description = "infra/bootstrap の適用に使うアクセスキー（create_bootstrap_user = true のとき）"
  value       = var.create_bootstrap_user ? aws_iam_access_key.bootstrap[0].id : null
  sensitive   = true
}

output "bootstrap_secret_access_key" {
  description = "同上のシークレット"
  value       = var.create_bootstrap_user ? aws_iam_access_key.bootstrap[0].secret : null
  sensitive   = true
}
