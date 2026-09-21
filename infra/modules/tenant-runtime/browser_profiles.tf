# Browser Profile本文（cookie / storage state）はControl Planeへ送らず、顧客Runtime内でSSE-KMS暗号化する。
resource "aws_s3_bucket" "browser_profiles" {
  count = local.browser_enabled ? 1 : 0

  bucket        = "${local.prefix}-browser-profiles-${local.account_id}-${var.region}"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "browser_profiles" {
  count = local.browser_enabled ? 1 : 0

  bucket                  = aws_s3_bucket.browser_profiles[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "browser_profiles" {
  count  = local.browser_enabled ? 1 : 0
  bucket = aws_s3_bucket.browser_profiles[0].id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "browser_profiles" {
  count  = local.browser_enabled ? 1 : 0
  bucket = aws_s3_bucket.browser_profiles[0].id
  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.this.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "browser_profiles" {
  count      = local.browser_enabled ? 1 : 0
  depends_on = [aws_s3_bucket_versioning.browser_profiles]
  bucket     = aws_s3_bucket.browser_profiles[0].id
  rule {
    id     = "expire-revoked-and-old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 30 }
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}
