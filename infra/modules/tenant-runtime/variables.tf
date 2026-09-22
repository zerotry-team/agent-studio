# テナント Runtime の入力（契約 §5）。
# 必須タグ（agentstudio:organization_id など）は呼び出し側の provider の default_tags で付ける。

variable "organization_id" {
  description = "Agent Studio の組織 ID（UUID）"
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.organization_id))
    error_message = "organization_id は小文字の UUID で指定してください。"
  }
}

variable "runtime_id" {
  description = "Agent Studio で登録した Runtime の ID（登録前は空でよい。タグにだけ使う）"
  type        = string
  default     = ""
}

variable "tenant_short" {
  description = "テナントの短い名前（config.yaml の short_name）。接頭辞 as-<tenant_short>-<stage_short> に使う"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]+(-[a-z0-9]+)*$", var.tenant_short)) && length(var.tenant_short) <= 20
    error_message = "tenant_short は 20 文字以内の半角英小文字・数字・ハイフンで指定してください。"
  }
}

variable "stage" {
  description = "production / staging"
  type        = string

  validation {
    condition     = contains(["production", "staging"], var.stage)
    error_message = "stage は production または staging を指定してください。"
  }
}

variable "region" {
  description = "リージョン（provider のリージョンと同じにする）"
  type        = string
  default     = "ap-northeast-1"
}

variable "agent_studio_url" {
  description = "Agent Studio の公開 URL（例: https://dxxxx.cloudfront.net）"
  type        = string

  validation {
    condition     = can(regex("^https://[^/:]+(:[0-9]+)?/?$", var.agent_studio_url))
    error_message = "agent_studio_url は https://<ホスト名> の形式で指定してください（パスは付けない）。"
  }
}

variable "runtime_server_id" {
  description = "Agent Studio 側の RUNTIME_SERVER_ID（agent-studio-<env>）"
  type        = string
}

variable "image_registry" {
  description = "Agent Studio 側 ECR のホスト名（<account>.dkr.ecr.<region>.amazonaws.com）"
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com$", var.image_registry))
    error_message = "image_registry は <account>.dkr.ecr.<region>.amazonaws.com の形式で指定してください。"
  }
}

variable "image_tag" {
  description = "Runtime のイメージタグ（commit SHA）。\"none\" のときはサービスを起動しない"
  type        = string
  default     = "none"
}

variable "browser_enabled" {
  description = "移行用。true は browser_runtime.enabled=true と同じ（将来削除予定）"
  type        = bool
  default     = false
}

variable "browser_runtime" {
  description = "RunごとのBrowser Session Worker設定"
  type = object({
    enabled                  = optional(bool, false)
    session_isolation        = optional(string, "fargate_task")
    cpu                      = optional(number, 2048)
    memory                   = optional(number, 4096)
    ephemeral_storage_gib    = optional(number, 30)
    max_concurrent_sessions  = optional(number, 10)
    max_lifetime_minutes     = optional(number, 120)
    idle_timeout_minutes     = optional(number, 15)
    code_execution_enabled   = optional(bool, true)
    authenticated_profiles   = optional(bool, false)
    computer_actions_enabled = optional(bool, false)
    screenshot_audit_enabled = optional(bool, false)
  })
  default = {}

  validation {
    condition     = var.browser_runtime.session_isolation == "fargate_task"
    error_message = "browser_runtime.session_isolation は fargate_task にしてください。"
  }
}

variable "egress_policy" {
  description = "Browser egress制御。proxyはPhase 2でEgress Proxyを強制する"
  type = object({
    mode            = optional(string, "proxy")
    allowed_domains = optional(list(string), [])
  })
  default = {}

  validation {
    condition     = contains(["proxy", "legacy_direct"], var.egress_policy.mode)
    error_message = "現在のegress_policy.modeは proxy / legacy_direct のいずれかです（network_firewallは未実装）。"
  }
}

variable "demo_internal_api_enabled" {
  description = "受け入れシナリオ用の社内 API モックを動かすか"
  type        = bool
  default     = false
}

variable "allowed_internal_cidrs" {
  description = "Tool Gateway から到達を許す社内ネットワークの CIDR"
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.allowed_internal_cidrs : can(cidrhost(c, 0))])
    error_message = "allowed_internal_cidrs には CIDR を指定してください。"
  }
}

variable "extra_allowed_domains" {
  description = "DNS Firewall で追加で許可するドメイン（例: example.com、*.example.com）。Browser Worker で開くサイトもここに入れる"
  type        = list(string)
  default     = []
}

variable "session_worker" {
  description = "Session Worker の設定"
  type = object({
    cpu                  = optional(number, 1024)
    memory               = optional(number, 2048)
    max_concurrent       = optional(number, 10)
    max_lifetime_minutes = optional(number, 120)
    idle_timeout_minutes = optional(number, 15)
  })
  default = {}
}

variable "connections" {
  description = "業務システムの接続名（Secrets Manager に <secrets_prefix>/connections/<name> を空で作る）"
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.connections : can(regex("^[a-z0-9]+(-[a-z0-9]+)*$", c))])
    error_message = "connections の名前は半角英小文字・数字・ハイフンで指定してください。"
  }
}

variable "adapter_delivery_enabled" {
  description = "Builder が作った企業専用 Adapter（GitHub の PR → CI → merge）を Runtime へ導入する。作業領域・Adapter の S3 と GitHub への名前解決を用意する"
  type        = bool
  default     = true
}

variable "tool_config" {
  description = "Tool Gateway のツール設定（RuntimeToolConfig）。文字列中の <prefix> は as-<tenant_short>-<stage_short> に置き換える"
  type        = any
  default = {
    version      = 1
    tools        = []
    upstream_mcp = []
    policies     = []
  }
}

# ---- サイズなど ----

variable "vpc_cidr" {
  description = "VPC の CIDR（/16）。社内ネットワークと接続する場合は重ならないようにする"
  type        = string
  default     = "10.40.0.0/16"
}

variable "nat_gateway_count" {
  description = "NAT Gateway の数"
  type        = number
  default     = 1
}

variable "log_retention_days" {
  description = "CloudWatch Logs の保持日数"
  type        = number
  default     = 90
}

variable "secret_recovery_window_days" {
  description = "シークレットを削除したときの復旧期間（日）"
  type        = number
  default     = 7
}

variable "runtime_core_cpu" {
  type    = number
  default = 512
}

variable "runtime_core_memory" {
  type    = number
  default = 1024
}

variable "browser_worker_cpu" {
  type    = number
  default = 1024
}

variable "browser_worker_memory" {
  type    = number
  default = 2048
}

variable "demo_internal_api_cpu" {
  type    = number
  default = 256
}

variable "demo_internal_api_memory" {
  type    = number
  default = 512
}
