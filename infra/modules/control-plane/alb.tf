# ALB（public サブネット）。CloudFront からの要求で、ヘッダ X-Origin-Verify が一致するものだけを転送する。
# CloudFront 以外から直接来た要求や、ヘッダが一致しない要求は既定の 403 になる。

data "aws_ec2_managed_prefix_list" "cloudfront_origin_facing" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

locals {
  alb_https         = var.alb_certificate_arn != ""
  alb_listener_port = local.alb_https ? 443 : 80

  # CloudFront でも同じパスを api に振り分ける
  api_path_patterns = ["/api/*", "/runtime/*", "/health"]
}

resource "aws_lb" "this" {
  name               = local.name
  load_balancer_type = "application"
  internal           = false
  security_groups    = [aws_security_group.alb.id]
  subnets            = module.network.public_subnet_ids

  drop_invalid_header_fields = true
  # Runtime の long-poll を切らないよう、CloudFront の待ち時間より長くする
  idle_timeout               = 120
  enable_deletion_protection = var.alb_deletion_protection
}

resource "aws_lb_target_group" "api" {
  name                 = "${local.name}-api"
  port                 = 3200
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = module.network.vpc_id
  deregistration_delay = 30

  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

# Human Loginのuser/runtime WebSocketを同じprocess内でpairする専用target。
# 通常APIを複数台へscaleしても、Relayは単一serviceへ集約する。
resource "aws_lb_target_group" "relay" {
  name                 = "${local.name}-relay"
  port                 = 3200
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = module.network.vpc_id
  deregistration_delay = 30

  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_target_group" "web" {
  name                 = "${local.name}-web"
  port                 = 3201
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = module.network.vpc_id
  deregistration_delay = 30

  health_check {
    path                = "/api/health"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "this" {
  load_balancer_arn = aws_lb.this.arn
  port              = local.alb_listener_port
  protocol          = local.alb_https ? "HTTPS" : "HTTP"
  ssl_policy        = local.alb_https ? "ELBSecurityPolicy-TLS13-1-2-2021-06" : null
  certificate_arn   = local.alb_https ? var.alb_certificate_arn : null

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Forbidden"
      status_code  = "403"
    }
  }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.this.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    http_header {
      http_header_name = "X-Origin-Verify"
      values           = [random_password.origin_verify.result]
    }
  }

  condition {
    path_pattern {
      values = local.api_path_patterns
    }
  }
}

resource "aws_lb_listener_rule" "relay" {
  listener_arn = aws_lb_listener.this.arn
  priority     = 5

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.relay.arn
  }

  condition {
    http_header {
      http_header_name = "X-Origin-Verify"
      values           = [random_password.origin_verify.result]
    }
  }

  condition {
    path_pattern {
      values = ["/relay/*"]
    }
  }
}

resource "aws_lb_listener_rule" "web" {
  listener_arn = aws_lb_listener.this.arn
  priority     = 20

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }

  condition {
    http_header {
      http_header_name = "X-Origin-Verify"
      values           = [random_password.origin_verify.result]
    }
  }
}
