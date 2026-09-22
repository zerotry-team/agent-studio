# Cognito ユーザープール（メールアドレスでサインイン、TOTP の MFA は任意）
# ユーザーは招待（AdminCreateUser）でだけ作る。自己登録は受け付けない。

resource "aws_cognito_user_pool" "this" {
  name                = local.name
  deletion_protection = var.cognito_deletion_protection ? "ACTIVE" : "INACTIVE"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  username_configuration {
    case_sensitive = false
  }

  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = true

    string_attribute_constraints {
      min_length = 5
      max_length = 254
    }
  }

  mfa_configuration = "OPTIONAL"
  software_token_mfa_configuration {
    enabled = true
  }

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 7
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  admin_create_user_config {
    allow_admin_create_user_only = true

    invite_message_template {
      email_subject = "Agent Studio への招待"
      email_message = "Agent Studio に招待されました。<br><br>ログイン画面: ${local.public_url}/<br>メールアドレス: {username}<br>仮パスワード: {####}<br><br>最初のログインでパスワードを変更してください。仮パスワードの有効期限は 7 日です。"
      sms_message   = "Agent Studio ユーザー名: {username} 仮パスワード: {####}"
    }
  }

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
  }

  # 送信数に上限がある（1 日 50 通程度）。本番で招待が増えたら SES に切り替える
  email_configuration {
    email_sending_account = "COGNITO_DEFAULT"
  }
}

resource "aws_cognito_user_pool_client" "web" {
  name         = "${local.name}-web"
  user_pool_id = aws_cognito_user_pool.this.id

  generate_secret                      = true
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]

  callback_urls = concat(["${local.public_url}/auth/callback"], var.additional_callback_urls)
  logout_urls   = concat(["${local.public_url}/"], var.additional_logout_urls)

  explicit_auth_flows           = ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"]
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  id_token_validity      = 1
  access_token_validity  = 1
  refresh_token_validity = 30

  token_validity_units {
    id_token      = "hours"
    access_token  = "hours"
    refresh_token = "days"
  }
}

# CLI（agent-studio login）用の公開クライアント。secret を持たず PKCE で使う。
# 戻り先はローカルの固定ポート（packages/cli の CALLBACK_PORT と合わせる）。
resource "aws_cognito_user_pool_client" "cli" {
  name         = "${local.name}-cli"
  user_pool_id = aws_cognito_user_pool.this.id

  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]

  callback_urls = ["http://127.0.0.1:48127/callback"]
  logout_urls   = ["http://127.0.0.1:48127/"]

  explicit_auth_flows           = ["ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  id_token_validity      = 1
  access_token_validity  = 1
  refresh_token_validity = 30

  token_validity_units {
    id_token      = "hours"
    access_token  = "hours"
    refresh_token = "days"
  }
}

# Hosted UI のドメインの接頭辞は全リージョンで一意にする必要がある。
# 16 進の乱数にするのは、接頭辞に使えない語（aws / amazon / cognito）が偶然含まれないようにするため。
resource "random_id" "cognito_domain_suffix" {
  byte_length = 4
}

resource "aws_cognito_user_pool_domain" "this" {
  domain       = "${local.name}-${random_id.cognito_domain_suffix.hex}"
  user_pool_id = aws_cognito_user_pool.this.id
}

locals {
  cognito_domain_url = "https://${aws_cognito_user_pool_domain.this.domain}.auth.${local.region}.amazoncognito.com"
}

# 最初の運営管理者（自己登録は無効なので、1 人目は Terraform で招待する）
resource "aws_cognito_user" "initial_admin" {
  count = var.initial_admin_email != "" ? 1 : 0

  user_pool_id             = aws_cognito_user_pool.this.id
  username                 = var.initial_admin_email
  desired_delivery_mediums = ["EMAIL"]

  attributes = {
    email          = var.initial_admin_email
    email_verified = true
  }

  # パスワードの変更やメールアドレスの確認は利用者側で行うので、作成後の差分は見ない
  lifecycle {
    ignore_changes = [attributes, desired_delivery_mediums, message_action, enabled]
  }
}
