variable "image_registry" {
  description = "Agent Studio 側 ECR のホスト名（CI は vars.IMAGE_REGISTRY を渡す）"
  type        = string
}

variable "image_tag" {
  description = "Runtime のイメージタグ（commit SHA）。\"none\" ならサービスを起動しない"
  type        = string
  default     = "none"
}

variable "agent_studio_url" {
  description = "接続する Agent Studio の URL。空なら config.yaml の agent_studio_url を使う（CI は公開リポジトリに URL を置かないよう、シークレット AGENT_STUDIO_URL を渡す）"
  type        = string
  default     = ""
}
