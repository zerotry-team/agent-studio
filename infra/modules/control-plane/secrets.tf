# Secrets Manager（契約 §4.1）。値は Terraform の state にも入るため、state バケットは暗号化・非公開にしている。

# 英数字だけにする（SQL の CREATE ROLE、接続文字列、ALB のヘッダ条件で特殊文字の扱いを気にしなくてよいように）
resource "random_password" "db_app" {
  length  = 40
  special = false
}

resource "random_password" "runtime_token_secret" {
  length  = 48
  special = false
}

resource "random_password" "web_session_secret" {
  length  = 48
  special = false
}

resource "random_password" "origin_verify" {
  length  = 32
  special = false
}

locals {
  secret_names = toset([
    "db-app",
    "runtime-token-secret",
    "web-session-secret",
    "origin-verify",
    "cognito-client-secret",
    "anthropic-api-key",
    "orcarouter-api-key",
    "qiita-oauth-client-id",
    "qiita-oauth-client-secret",
  ])

  # Terraform が値を持つシークレット（外部モデル/OAuthキー以外）
  generated_secret_names = toset([
    "db-app",
    "runtime-token-secret",
    "web-session-secret",
    "origin-verify",
    "cognito-client-secret",
  ])

  generated_secret_values = {
    "db-app"                = random_password.db_app.result
    "runtime-token-secret"  = random_password.runtime_token_secret.result
    "web-session-secret"    = random_password.web_session_secret.result
    "origin-verify"         = random_password.origin_verify.result
    "cognito-client-secret" = aws_cognito_user_pool_client.web.client_secret
  }

  secret_arn = { for k, s in aws_secretsmanager_secret.this : k => s.arn }
}

resource "aws_secretsmanager_secret" "this" {
  for_each = local.secret_names

  name                    = "${local.name}/${each.value}"
  kms_key_id              = aws_kms_key.this.arn
  recovery_window_in_days = var.secret_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "generated" {
  for_each = local.generated_secret_names

  secret_id     = aws_secretsmanager_secret.this[each.value].id
  secret_string = local.generated_secret_values[each.value]
}

# Anthropic の API キーは運用者が設定する:
#   aws secretsmanager put-secret-value --secret-id as-<env>/anthropic-api-key --secret-string '<key>'
# それまでは "unset" が入っている（アプリは未設定として扱う）
resource "aws_secretsmanager_secret_version" "anthropic_api_key" {
  secret_id     = aws_secretsmanager_secret.this["anthropic-api-key"].id
  secret_string = "unset"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# 共有 Orca Router キーは任意。組織ごとの管理画面設定がある場合はそちらを優先する。
resource "aws_secretsmanager_secret_version" "orcarouter_api_key" {
  secret_id     = aws_secretsmanager_secret.this["orcarouter-api-key"].id
  secret_string = "unset"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# Qiita OAuth applicationは運用者がQiita上で登録後に値を設定する。
resource "aws_secretsmanager_secret_version" "qiita_oauth" {
  for_each = toset(["qiita-oauth-client-id", "qiita-oauth-client-secret"])

  secret_id     = aws_secretsmanager_secret.this[each.value].id
  secret_string = "unset"

  lifecycle {
    ignore_changes = [secret_string]
  }
}
