variable "region" {
  description = "リージョン"
  type        = string
  default     = "ap-northeast-1"
}

variable "aws_account_id" {
  description = "適用先の AWS アカウント ID（CI は vars.AWS_ACCOUNT_ID を渡す）。別アカウントへの誤適用を防ぐ。空ならチェックしない"
  type        = string
  default     = ""
}

variable "image_registry" {
  description = "ECR レジストリのホスト名（<account>.dkr.ecr.<region>.amazonaws.com）"
  type        = string
}

variable "image_tag" {
  description = "api / worker / web のイメージタグ（commit SHA）。\"none\" ならサービスを起動しない"
  type        = string
  default     = "none"
}

variable "migrate_image_tag" {
  description = "migrate タスク定義のイメージタグ（commit SHA）"
  type        = string
  default     = "none"
}

variable "domain_name" {
  description = "独自ドメイン（空なら CloudFront の既定ドメイン）"
  type        = string
  default     = ""
}

variable "acm_certificate_arn_us_east_1" {
  description = "domain_name 用の ACM 証明書（us-east-1）"
  type        = string
  default     = ""
}

variable "alb_certificate_arn" {
  description = "ALB 用の ACM 証明書（ap-northeast-1）。指定すると CloudFront → ALB を HTTPS にする"
  type        = string
  default     = ""
}

variable "openai_default_model" {
  description = "OPENAI_DEFAULT_MODEL（Manifest で model.name を指定しない Agent が使うモデル）。OpenAI のドキュメントの例に合わせている"
  type        = string
  default     = "gpt-6-astra"
}

variable "manifest_generator_model" {
  description = "MANIFEST_GENERATOR_MODEL（Claude のモデル ID）"
  type        = string
  default     = "claude-opus-5"
}
