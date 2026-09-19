# KMS キーと Secrets Manager（契約 §5.1）

data "aws_iam_policy_document" "kms" {
  statement {
    sid       = "AccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account_id}:root"]
    }
  }

  statement {
    sid = "CloudWatchLogs"
    actions = [
      "kms:Encrypt*",
      "kms:Decrypt*",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:Describe*",
    ]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.${var.region}.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:${local.partition}:logs:${var.region}:${local.account_id}:log-group:*"]
    }
  }
}

resource "aws_kms_key" "this" {
  description             = "Agent Studio Runtime ${local.prefix}"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.kms.json
}

resource "aws_kms_alias" "this" {
  name          = "alias/${local.prefix}"
  target_key_id = aws_kms_key.this.key_id
}

# ---- Bootstrap Token（運用者が put-secret-value で入れる。Terraform は値を持たない） ----

resource "aws_secretsmanager_secret" "bootstrap_token" {
  name                    = "${local.secrets_prefix}/bootstrap-token"
  description             = "Bootstrap token issued by Agent Studio (single use)"
  kms_key_id              = aws_kms_key.this.arn
  recovery_window_in_days = var.secret_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "bootstrap_token" {
  secret_id     = aws_secretsmanager_secret.bootstrap_token.id
  secret_string = "unset"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# ---- OpenAI の環境キー（Runtime Controller が登録時に書き込む） ----

resource "aws_secretsmanager_secret" "openai_environment_key" {
  name                    = "${local.secrets_prefix}/openai-environment-key"
  description             = "OpenAI environment key (CODEX_API_KEY of Session Worker)"
  kms_key_id              = aws_kms_key.this.arn
  recovery_window_in_days = var.secret_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "openai_environment_key" {
  secret_id     = aws_secretsmanager_secret.openai_environment_key.id
  secret_string = "unset"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# ---- 業務システムの認証情報（空で作り、値は顧客が入れる） ----

resource "aws_secretsmanager_secret" "connection" {
  for_each = toset(local.connection_names)

  name                    = "${local.secrets_prefix}/connections/${each.value}"
  description             = "Credential for ${each.value} (read only by Tool Gateway)"
  kms_key_id              = aws_kms_key.this.arn
  recovery_window_in_days = var.secret_recovery_window_days
}
