# 要件定義書 §12.1 の AWS Organizations の構成のうち、Agent Studio と企業の Runtime のアカウントを作る。
#
# 作ったアカウントには OrganizationAccountAccessRole ができる（管理アカウントから引き受けて管理者として操作できる）。
# 続く infra/bootstrap はこのロールを引き受けて適用するので、アカウントごとの認証情報を作らなくてよい。

resource "aws_organizations_organization" "this" {
  count = var.create_organization ? 1 : 0

  feature_set          = "ALL"
  enabled_policy_types = ["SERVICE_CONTROL_POLICY"]
}

data "aws_organizations_organization" "this" {
  depends_on = [aws_organizations_organization.this]
}

locals {
  organization_id = data.aws_organizations_organization.this.id
  root_id         = data.aws_organizations_organization.this.roots[0].id
}

resource "aws_organizations_organizational_unit" "this" {
  for_each = toset(var.organizational_units)

  name      = each.value
  parent_id = local.root_id
}

resource "aws_organizations_account" "this" {
  for_each = var.accounts

  name      = each.key
  email     = each.value.email
  parent_id = aws_organizations_organizational_unit.this[each.value.ou].id
  role_name = "OrganizationAccountAccessRole"

  # アカウントの削除（閉鎖）は取り消せないため、Terraform からは削除しない
  close_on_deletion = false

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [role_name, iam_user_access_to_billing]
  }
}

# ---- Companies OU のガードレール（SCP） ----
# 企業の Runtime のアカウントで、許可したリージョン以外を使わせない・証跡や組織からの離脱を止めさせない。

data "aws_iam_policy_document" "companies_guardrails" {
  statement {
    sid       = "DenyLeaveOrganization"
    effect    = "Deny"
    actions   = ["organizations:LeaveOrganization"]
    resources = ["*"]
  }

  statement {
    sid       = "DenyStopCloudTrail"
    effect    = "Deny"
    actions   = ["cloudtrail:StopLogging", "cloudtrail:DeleteTrail"]
    resources = ["*"]
  }

  dynamic "statement" {
    for_each = length(var.allowed_regions) > 0 ? [1] : []
    content {
      sid    = "DenyOtherRegions"
      effect = "Deny"
      # グローバルなサービスはリージョンの制限から外す
      not_actions = [
        "iam:*", "organizations:*", "sts:*", "support:*", "cloudfront:*", "route53:*", "route53domains:*",
        "waf:*", "wafv2:*", "shield:*", "acm:*", "budgets:*", "ce:*", "health:*", "account:*",
      ]
      resources = ["*"]
      condition {
        test     = "StringNotEquals"
        variable = "aws:RequestedRegion"
        values   = var.allowed_regions
      }
    }
  }
}

resource "aws_organizations_policy" "companies_guardrails" {
  count = var.attach_companies_scp ? 1 : 0

  name        = "agent-studio-companies-guardrails"
  description = "Guardrails for company runtime accounts (region restriction, no CloudTrail stop, no leaving organization)"
  type        = "SERVICE_CONTROL_POLICY"
  content     = data.aws_iam_policy_document.companies_guardrails.json
}

resource "aws_organizations_policy_attachment" "companies_guardrails" {
  count = var.attach_companies_scp && contains(var.organizational_units, "Companies") ? 1 : 0

  policy_id = aws_organizations_policy.companies_guardrails[0].id
  target_id = aws_organizations_organizational_unit.this["Companies"].id
}
