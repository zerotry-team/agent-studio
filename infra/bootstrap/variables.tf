variable "aws_account_id" {
  description = "適用先の AWS アカウント ID（別のアカウントに誤って適用するのを防ぐ）"
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id は 12 桁の数字で指定してください。"
  }
}

variable "region" {
  description = "リージョン"
  type        = string
  default     = "ap-northeast-1"
}

variable "environment" {
  description = "タグ agentstudio:environment の値（例: staging、production、sample-a-company-prod）"
  type        = string
}

variable "github_repository" {
  description = "デプロイを許可する GitHub リポジトリ（owner/name）"
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository は owner/name の形式で指定してください。"
  }
}

variable "github_environments" {
  description = "このアカウントにデプロイできる GitHub Environment の名前（例: [\"agent-studio-staging\"]、[\"company-sample-a-company-production\"]）"
  type        = list(string)

  validation {
    condition     = length(var.github_environments) > 0
    error_message = "github_environments を 1 つ以上指定してください。"
  }
}

variable "create_github_oidc_provider" {
  description = "GitHub Actions の OIDC プロバイダーを作るか（アカウントに既にある場合は false にして既存のものを使う）"
  type        = bool
  default     = true
}

variable "deploy_role_name" {
  description = "GitHub Actions が引き受ける IAM ロールの名前"
  type        = string
  default     = "as-github-deploy"
}

variable "create_ecr_repositories" {
  description = "ECR リポジトリを作るか（Agent Studio のアカウントでは true、テナントのアカウントでは false）"
  type        = bool
  default     = true
}

variable "ecr_image_retention_count" {
  description = "各リポジトリに残すイメージの数"
  type        = number
  default     = 50
}

variable "ecr_pull_organization_id" {
  description = "Runtime 用イメージの pull を許可する AWS Organizations の ID（o-xxxxxxxxxx）。空なら許可しない"
  type        = string
  default     = ""

  validation {
    condition     = var.ecr_pull_organization_id == "" || can(regex("^o-[a-z0-9]{10,32}$", var.ecr_pull_organization_id))
    error_message = "ecr_pull_organization_id は o- で始まる Organizations の ID を指定してください。"
  }
}

variable "ecr_pull_account_ids" {
  description = "Runtime 用イメージの pull を許可する AWS アカウント ID（組織外の顧客アカウントなど）"
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for id in var.ecr_pull_account_ids : can(regex("^[0-9]{12}$", id))])
    error_message = "ecr_pull_account_ids は 12 桁の数字で指定してください。"
  }
}

variable "assume_role_arn" {
  description = "適用時に引き受ける IAM ロール（infra/organization の出力 admin_role_arns）。空なら今の認証情報のまま適用する"
  type        = string
  default     = ""
}

variable "manage_github_environments" {
  description = "GitHub Environment（github_environments）と、その変数（AWS_REGION など）を Terraform で作るか"
  type        = bool
  default     = false
}

variable "github_environment_variables" {
  description = "GitHub Environment に追加で設定する変数（例: company 環境の IMAGE_REGISTRY、agent-studio 環境の INITIAL_ADMIN_EMAIL）"
  type        = map(string)
  default     = {}
}

variable "github_deployment_branch" {
  description = "GitHub Environment からデプロイできるブランチ"
  type        = string
  default     = "main"
}

variable "github_environment_secrets" {
  description = "GitHub Environment に設定するシークレット（ログで *** に置き換わる。公開リポジトリで見せたくない値。例: INITIAL_ADMIN_EMAIL、IMAGE_REGISTRY）"
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "create_ecs_service_linked_role" {
  description = "ECS のサービスリンクロール（AWSServiceRoleForECS）を作るか。新しいアカウントには無く、Service Connect を使うクラスターの作成が失敗するため作っておく。アカウントに既にある場合は false"
  type        = bool
  default     = true
}

variable "github_oidc_sub_prefix" {
  description = <<-EOT
    GitHub の OIDC トークンの sub の接頭辞（リポジトリで「変更されない ID を含む形式」を使っている場合）。
    gh api repos/<owner>/<repo>/actions/oidc/customization/sub の sub_claim_prefix（例: repo:owner@123/name@456）。
    空なら従来の形式（repo:<owner>/<name>）だけを信頼する
  EOT
  type        = string
  default     = ""
}
