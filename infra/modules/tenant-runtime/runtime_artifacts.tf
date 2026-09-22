# Builder の作業領域（clone した Repository・commit の bundle）と、CI が署名した企業専用 Adapter を置く。
# Control Plane へは送らず、顧客 Runtime 内で SSE-KMS 暗号化する。Session Worker には権限を付けない
# （受け渡しは Tool Gateway が Session 専用 token を確かめてから Controller が行う）。
resource "aws_s3_bucket" "runtime_artifacts" {
  count = var.adapter_delivery_enabled ? 1 : 0

  bucket        = "${local.prefix}-runtime-artifacts-${local.account_id}-${var.region}"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "runtime_artifacts" {
  count = var.adapter_delivery_enabled ? 1 : 0

  bucket                  = aws_s3_bucket.runtime_artifacts[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "runtime_artifacts" {
  count  = var.adapter_delivery_enabled ? 1 : 0
  bucket = aws_s3_bucket.runtime_artifacts[0].id
  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.this.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "runtime_artifacts" {
  count  = var.adapter_delivery_enabled ? 1 : 0
  bucket = aws_s3_bucket.runtime_artifacts[0].id
  # 公開済みの作業領域は Controller が消す。途中で止まったものも残さない
  rule {
    id     = "expire-builder-workspaces"
    status = "Enabled"
    filter { prefix = "builder-workspaces/" }
    expiration { days = 7 }
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}
