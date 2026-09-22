# CloudFront + WAF
# すべての経路でキャッシュしない（CachingDisabled）。ヘッダ・Cookie・クエリはすべて ALB に転送する（AllViewer）。

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewer"
}

locals {
  custom_domain  = var.domain_name != ""
  alb_origin_id  = "alb"
  all_methods    = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
  cached_methods = ["GET", "HEAD"]
}

resource "aws_cloudfront_distribution" "this" {
  enabled             = true
  comment             = "Agent Studio ${var.environment}"
  is_ipv6_enabled     = true
  http_version        = "http2and3"
  price_class         = var.cloudfront_price_class
  aliases             = local.custom_domain ? [var.domain_name] : []
  web_acl_id          = aws_wafv2_web_acl.this.arn
  wait_for_deployment = false

  origin {
    origin_id   = local.alb_origin_id
    domain_name = aws_lb.this.dns_name

    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = local.alb_https ? "https-only" : "http-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = var.cloudfront_origin_read_timeout
      origin_keepalive_timeout = 5
    }

    # ALB はこのヘッダが一致する要求だけを転送する
    custom_header {
      name  = "X-Origin-Verify"
      value = random_password.origin_verify.result
    }
  }

  # web（上の ordered_cache_behavior に当てはまらないパスすべて）
  default_cache_behavior {
    target_origin_id         = local.alb_origin_id
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = local.all_methods
    cached_methods           = local.cached_methods
    compress                 = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
  }

  # api（/api/*、/runtime/*、/health、/health/*、/webhooks/*、/triggers/*）。振り分け自体は ALB のパス条件で行う
  dynamic "ordered_cache_behavior" {
    for_each = concat(local.api_path_patterns, local.webhook_path_patterns)
    content {
      path_pattern             = ordered_cache_behavior.value
      target_origin_id         = local.alb_origin_id
      viewer_protocol_policy   = "redirect-to-https"
      allowed_methods          = local.all_methods
      cached_methods           = local.cached_methods
      compress                 = true
      cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
      origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = !local.custom_domain
    acm_certificate_arn            = local.custom_domain ? var.acm_certificate_arn_us_east_1 : null
    ssl_support_method             = local.custom_domain ? "sni-only" : null
    minimum_protocol_version       = local.custom_domain ? "TLSv1.2_2021" : null
  }
}

# CloudFront 用の WAF は us-east-1 に作る
resource "aws_wafv2_web_acl" "this" {
  provider = aws.us_east_1

  name        = local.name
  description = "Agent Studio ${var.environment}"
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "aws-common"
    priority = 10

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"

        # 本文 8KB 超を遮断するルール。Agent の Manifest やツール定義の保存で超えるため、記録だけにする
        rule_action_override {
          name = "SizeRestrictions_BODY"
          action_to_use {
            count {}
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-aws-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-known-bad-inputs"
    priority = 20

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-aws-known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "rate-limit-per-ip"
    priority = 30

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit                 = var.waf_rate_limit
        aggregate_key_type    = "IP"
        evaluation_window_sec = 300
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = local.name
    sampled_requests_enabled   = true
  }
}
