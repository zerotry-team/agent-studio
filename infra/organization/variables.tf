variable "management_account_id" {
  description = "AWS Organizations の管理アカウントの ID（このアカウントの認証情報で適用する。別のアカウントへの誤適用を防ぐ）"
  type        = string

  validation {
    condition     = can(regex("^\\d{12}$", var.management_account_id))
    error_message = "12 桁の数字で指定してください。"
  }
}

variable "region" {
  description = "リージョン（Organizations 自体はグローバル）"
  type        = string
  default     = "ap-northeast-1"
}

variable "create_organization" {
  description = "Organizations を新しく作るか。管理アカウントがすでに Organizations を使っている場合は false"
  type        = bool
  default     = true
}

variable "accounts" {
  description = <<-EOT
    作成するアカウント。キーはアカウント名（bootstrap の workspace 名にも使う）。
    email はアカウントごとに別のアドレスにする（例: aws+agent-studio-production@example.com）。
    ou は organizational_units のいずれか。
  EOT
  type = map(object({
    email = string
    ou    = string
  }))

  validation {
    condition     = alltrue([for a in values(var.accounts) : can(regex("^[^@\\s]+@[^@\\s]+$", a.email))])
    error_message = "email の形式が正しくありません。"
  }
}

variable "organizational_units" {
  description = "作成する OU（要件定義書 §12.1: Platform = Agent Studio 本体、Companies = 企業の Runtime）"
  type        = list(string)
  default     = ["Platform", "Companies"]
}

variable "allowed_regions" {
  description = "Companies OU で使えるリージョン（SCP）。空ならリージョンの制限をかけない"
  type        = list(string)
  default     = ["ap-northeast-1"]
}

variable "attach_companies_scp" {
  description = "Companies OU に SCP（ガードレール）を付けるか。Organizations で SCP が有効になっていない場合、true にすると組織全体で SCP を有効にする必要がある"
  type        = bool
  default     = true
}

variable "create_bootstrap_user" {
  description = <<-EOT
    infra/bootstrap の適用に使う IAM ユーザーを作るか。ルートユーザーはロールを引き受けられないため、
    作成したアカウントに入るための最小限のユーザー（OrganizationAccountAccessRole の引き受けだけができる）を作る。
    初期設定が終わったら false にして適用し、削除する。
  EOT
  type        = bool
  default     = false
}
