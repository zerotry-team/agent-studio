variable "name" {
  description = "リソース名の接頭辞（例: as-staging、as-sample-a-prod）"
  type        = string
}

variable "cidr_block" {
  description = "VPC の CIDR（/16 を想定）"
  type        = string

  validation {
    condition     = can(cidrhost(var.cidr_block, 0)) && tonumber(split("/", var.cidr_block)[1]) <= 16
    error_message = "cidr_block は /16 以上の大きさの CIDR を指定してください。"
  }
}

variable "az_count" {
  description = "使う AZ の数"
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count は 2 または 3 を指定してください。"
  }
}

variable "nat_gateway_count" {
  description = "NAT Gateway の数（1 〜 az_count）"
  type        = number
  default     = 1

  validation {
    condition     = var.nat_gateway_count >= 1 && var.nat_gateway_count <= var.az_count
    error_message = "nat_gateway_count は 1 以上 az_count 以下を指定してください。"
  }
}

variable "create_database_subnets" {
  description = "DB 用のサブネット（インターネットへの経路なし）を作るか"
  type        = bool
  default     = false
}

variable "tags" {
  description = "追加のタグ"
  type        = map(string)
  default     = {}
}
