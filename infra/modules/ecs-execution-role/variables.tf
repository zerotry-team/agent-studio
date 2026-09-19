variable "name" {
  description = "IAM ロール名"
  type        = string
}

variable "ecr_repository_arns" {
  description = "pull を許可する ECR リポジトリの ARN"
  type        = list(string)
}

variable "log_group_arns" {
  description = "書き込みを許可する CloudWatch Logs のロググループ ARN（末尾の :* は付けない）"
  type        = list(string)
}

variable "secret_arns" {
  description = "タスク定義の secrets で注入するシークレットの ARN"
  type        = list(string)
  default     = []
}

variable "kms_key_arn" {
  description = "シークレットの暗号化に使う KMS キーの ARN（secret_arns があるときは必須）"
  type        = string
  default     = null

  validation {
    condition     = length(var.secret_arns) == 0 || var.kms_key_arn != null
    error_message = "secret_arns を指定する場合は kms_key_arn も指定してください。"
  }
}

variable "tags" {
  type    = map(string)
  default = {}
}
