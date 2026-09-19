variable "image_registry" {
  description = "Agent Studio 側 ECR のホスト名（CI は vars.IMAGE_REGISTRY を渡す）"
  type        = string
}

variable "image_tag" {
  description = "Runtime のイメージタグ（commit SHA）。\"none\" ならサービスを起動しない"
  type        = string
  default     = "none"
}
