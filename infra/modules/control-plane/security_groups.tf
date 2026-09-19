# セキュリティグループ
#   alb     ← CloudFront（origin-facing のプレフィックスリスト）
#   api     ← alb、web（Service Connect）
#   web     ← alb
#   worker / migrate: 受信なし
#   db      ← api、worker、migrate（5432）

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "ALB: CloudFront からだけ受け付ける"
  vpc_id      = module.network.vpc_id
  tags        = { Name = "${local.name}-alb" }
}

resource "aws_security_group" "api" {
  name        = "${local.name}-api"
  description = "API"
  vpc_id      = module.network.vpc_id
  tags        = { Name = "${local.name}-api" }
}

resource "aws_security_group" "worker" {
  name        = "${local.name}-worker"
  description = "Worker"
  vpc_id      = module.network.vpc_id
  tags        = { Name = "${local.name}-worker" }
}

resource "aws_security_group" "web" {
  name        = "${local.name}-web"
  description = "Web"
  vpc_id      = module.network.vpc_id
  tags        = { Name = "${local.name}-web" }
}

resource "aws_security_group" "migrate" {
  name        = "${local.name}-migrate"
  description = "DB migration task"
  vpc_id      = module.network.vpc_id
  tags        = { Name = "${local.name}-migrate" }
}

resource "aws_security_group" "db" {
  name        = "${local.name}-db"
  description = "RDS PostgreSQL"
  vpc_id      = module.network.vpc_id
  tags        = { Name = "${local.name}-db" }
}

# ---- ALB ----

# プレフィックスリストは「エントリ数」分のルールとして数えられる（CloudFront は 50 以上）。
# SG あたりのルール数の上限（既定 60）を超えないよう、ポートは 1 つ（80 または 443）だけにする。
resource "aws_vpc_security_group_ingress_rule" "alb_from_cloudfront" {
  security_group_id = aws_security_group.alb.id
  description       = "CloudFront origin-facing"
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront_origin_facing.id
  ip_protocol       = "tcp"
  from_port         = local.alb_listener_port
  to_port           = local.alb_listener_port
}

resource "aws_vpc_security_group_egress_rule" "alb_to_api" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = 3200
  to_port                      = 3200
}

resource "aws_vpc_security_group_egress_rule" "alb_to_web" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.web.id
  ip_protocol                  = "tcp"
  from_port                    = 3201
  to_port                      = 3201
}

# ---- API ----

resource "aws_vpc_security_group_ingress_rule" "api_from_alb" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 3200
  to_port                      = 3200
}

resource "aws_vpc_security_group_ingress_rule" "api_from_web" {
  security_group_id            = aws_security_group.api.id
  description                  = "Service Connect (web -> api)"
  referenced_security_group_id = aws_security_group.web.id
  ip_protocol                  = "tcp"
  from_port                    = 3200
  to_port                      = 3200
}

# ---- Web ----

resource "aws_vpc_security_group_ingress_rule" "web_from_alb" {
  security_group_id            = aws_security_group.web.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 3201
  to_port                      = 3201
}

resource "aws_vpc_security_group_egress_rule" "web_to_api" {
  security_group_id            = aws_security_group.web.id
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = 3200
  to_port                      = 3200
}

# ---- 共通の送信: HTTPS（AWS API、ECR、OpenAI、Anthropic、Cognito など）----

resource "aws_vpc_security_group_egress_rule" "https" {
  for_each = {
    api     = aws_security_group.api.id
    worker  = aws_security_group.worker.id
    web     = aws_security_group.web.id
    migrate = aws_security_group.migrate.id
  }

  security_group_id = each.value
  description       = "HTTPS to AWS APIs and external services"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

# ---- DB ----

resource "aws_vpc_security_group_egress_rule" "to_db" {
  for_each = {
    api     = aws_security_group.api.id
    worker  = aws_security_group.worker.id
    migrate = aws_security_group.migrate.id
  }

  security_group_id            = each.value
  referenced_security_group_id = aws_security_group.db.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_ingress_rule" "db_from_app" {
  for_each = {
    api     = aws_security_group.api.id
    worker  = aws_security_group.worker.id
    migrate = aws_security_group.migrate.id
  }

  security_group_id            = aws_security_group.db.id
  description                  = "PostgreSQL from ${each.key}"
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}
