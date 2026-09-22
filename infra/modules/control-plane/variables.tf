# ---- 基本 ----

variable "environment" {
  description = "環境名（staging / production）。リソース名の接頭辞 as-<environment> になる"
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment は staging または production を指定してください。"
  }
}

variable "vpc_cidr" {
  description = "VPC の CIDR（/16）"
  type        = string
  default     = "10.20.0.0/16"
}

variable "nat_gateway_count" {
  description = "NAT Gateway の数（staging 1、production 2）"
  type        = number
  default     = 1
}

variable "log_retention_days" {
  description = "CloudWatch Logs の保持日数"
  type        = number
  default     = 90
}

variable "secret_recovery_window_days" {
  description = "Secrets Manager のシークレットを削除したときの復旧期間（日）。0 で即時削除"
  type        = number
  default     = 7
}

# ---- イメージ ----

variable "image_registry" {
  description = "ECR レジストリのホスト名（<account>.dkr.ecr.<region>.amazonaws.com）"
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com$", var.image_registry))
    error_message = "image_registry は <account>.dkr.ecr.<region>.amazonaws.com の形式で指定してください。"
  }
}

variable "image_tag" {
  description = "api / worker / web のイメージタグ（commit SHA）。\"none\" のときはサービスの台数を 0 にする"
  type        = string
  default     = "none"
}

variable "migrate_image_tag" {
  description = "migrate タスク定義のイメージタグ（commit SHA）"
  type        = string
  default     = "none"
}

# ---- 公開ドメイン ----

variable "domain_name" {
  description = "独自ドメイン（例: studio.example.com）。空なら CloudFront の既定ドメインを使う"
  type        = string
  default     = ""
}

variable "acm_certificate_arn_us_east_1" {
  description = "domain_name 用の ACM 証明書（us-east-1）の ARN"
  type        = string
  default     = ""

  validation {
    condition     = (var.domain_name == "") == (var.acm_certificate_arn_us_east_1 == "")
    error_message = "domain_name と acm_certificate_arn_us_east_1 は両方指定するか、両方空にしてください。"
  }
}

variable "alb_certificate_arn" {
  description = "ALB 用の ACM 証明書（このリージョン）の ARN。指定すると CloudFront → ALB を HTTPS にする。証明書は domain_name を含むこと"
  type        = string
  default     = ""

  validation {
    condition     = var.alb_certificate_arn == "" || var.domain_name != ""
    error_message = "alb_certificate_arn を指定する場合は domain_name も指定してください（CloudFront は Host ヘッダの名前で ALB の証明書を検証するため）。"
  }
}

variable "cloudfront_price_class" {
  description = "CloudFront の価格クラス（PriceClass_200 は日本を含む）"
  type        = string
  default     = "PriceClass_200"
}

variable "cloudfront_origin_read_timeout" {
  description = "CloudFront がオリジンの応答を待つ秒数（Runtime の long-poll はこれより短くする）。60 を超えるにはクォータの引き上げが必要"
  type        = number
  default     = 60
}

variable "waf_rate_limit" {
  description = "WAF のレート制限（1 IP あたり 5 分間のリクエスト数）"
  type        = number
  default     = 2000
}

variable "alb_deletion_protection" {
  description = "ALB の削除保護"
  type        = bool
  default     = false
}

# ---- Cognito ----

variable "cognito_deletion_protection" {
  description = "ユーザープールの削除保護"
  type        = bool
  default     = true
}

variable "additional_callback_urls" {
  description = "追加のコールバック URL（例: ローカル開発用の http://localhost:3201/auth/callback）"
  type        = list(string)
  default     = []
}

variable "additional_logout_urls" {
  description = "追加のサインアウト後の URL"
  type        = list(string)
  default     = []
}

# ---- RDS ----

variable "db_engine_version" {
  description = "PostgreSQL のバージョン（メジャーだけ指定するとマイナーは自動で上がる）"
  type        = string
  default     = "16"
}

variable "db_instance_class" {
  description = "RDS のインスタンスクラス"
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "RDS のストレージ（GiB）"
  type        = number
  default     = 20
}

variable "db_max_allocated_storage" {
  description = "ストレージの自動拡張の上限（GiB）"
  type        = number
  default     = 100
}

variable "db_multi_az" {
  description = "RDS を Multi-AZ にするか"
  type        = bool
  default     = false
}

variable "db_backup_retention_days" {
  description = "自動バックアップの保持日数（1 以上でポイントインタイムリカバリが有効）"
  type        = number
  default     = 7

  validation {
    condition     = var.db_backup_retention_days >= 1 && var.db_backup_retention_days <= 35
    error_message = "db_backup_retention_days は 1〜35 を指定してください。"
  }
}

variable "db_deletion_protection" {
  description = "RDS の削除保護"
  type        = bool
  default     = true
}

variable "db_skip_final_snapshot" {
  description = "RDS を削除するときに最終スナップショットを取らないか"
  type        = bool
  default     = false
}

variable "db_performance_insights_enabled" {
  description = "Performance Insights を有効にするか"
  type        = bool
  default     = false
}

variable "db_apply_immediately" {
  description = "RDS の変更をメンテナンスウィンドウを待たずに適用するか"
  type        = bool
  default     = false
}

# ---- S3 ----

variable "audit_object_lock_days" {
  description = "監査バケットの Object Lock（ガバナンスモード）の保持日数"
  type        = number
  default     = 365
}

# ---- アプリ ----

variable "agents_api_mode" {
  description = "AGENTS_API_MODE（openai / fake）"
  type        = string
  default     = "openai"

  validation {
    condition     = contains(["openai", "fake"], var.agents_api_mode)
    error_message = "agents_api_mode は openai または fake を指定してください。"
  }
}

variable "openai_default_model" {
  description = "OPENAI_DEFAULT_MODEL。空なら環境変数を設定せず、アプリの既定値を使う"
  type        = string
  default     = ""
}

variable "manifest_generator_model" {
  description = "MANIFEST_GENERATOR_MODEL（日本語 → Manifest の生成に使う OpenAI Responses API のモデル ID）"
  type        = string
  default     = "gpt-5.6"
}

variable "log_level" {
  description = "LOG_LEVEL"
  type        = string
  default     = "info"
}

variable "managed_runtime_provisioning_role_arn" {
  description = "Organizations管理アカウントにあるManaged Runtime構築ロール。空なら自動構築を無効にする"
  type        = string
  default     = ""
}

variable "managed_runtime_state_bucket" {
  description = "Managed RuntimeごとのTerraform stateを置く管理アカウントのS3バケット"
  type        = string
  default     = ""

  validation {
    condition     = var.managed_runtime_provisioning_role_arn == "" || var.managed_runtime_state_bucket != ""
    error_message = "managed_runtime_provisioning_role_arnを指定するときはmanaged_runtime_state_bucketも必要です。"
  }
}

variable "managed_runtime_account_email_domain" {
  description = "新規AWSアカウントの一意なメールアドレスに使うドメイン"
  type        = string
  default     = "zerotry.dev"
}

variable "managed_runtime_max_concurrent" {
  description = "同時に構築するManaged Runtime数"
  type        = number
  default     = 1
}

# ---- ECS のサイズ ----

variable "api_desired_count" {
  type    = number
  default = 1
}

variable "worker_desired_count" {
  type    = number
  default = 1

  validation {
    condition     = var.worker_desired_count >= 1
    error_message = "worker_desired_count は 1 以上にしてください。"
  }
}

variable "web_desired_count" {
  type    = number
  default = 1
}

variable "api_cpu" {
  type    = number
  default = 512
}

variable "api_memory" {
  type    = number
  default = 1024
}

variable "worker_cpu" {
  type    = number
  default = 512
}

variable "worker_memory" {
  type    = number
  default = 1024
}

variable "web_cpu" {
  type    = number
  default = 512
}

variable "web_memory" {
  type    = number
  default = 1024
}

variable "migrate_cpu" {
  type    = number
  default = 512
}

variable "migrate_memory" {
  type    = number
  default = 1024
}

variable "initial_admin_email" {
  description = "最初の運営管理者のメールアドレス。Cognito に招待（メールで仮パスワードが届く）し、migrate が運営管理者の権限を付ける。空なら何もしない"
  type        = string
  default     = ""
}
