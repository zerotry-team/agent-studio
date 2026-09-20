# セキュリティグループ（契約 §5.2）
#   runtime-core   ← session-worker（8080）
#   session-worker   受信なし。送信は 443 と runtime-core:8080 と DNS だけ（社内ネットワークには届かない）
#   browser-worker ← runtime-core（8931）
#   demo-api       ← runtime-core（8090）

resource "aws_security_group" "runtime_core" {
  name        = "${local.prefix}-runtime-core"
  description = "Runtime Controller + Tool Gateway"
  vpc_id      = module.network.vpc_id
  tags        = { Name = "${local.prefix}-runtime-core" }
}

resource "aws_security_group" "session_worker" {
  name        = "${local.prefix}-session-worker"
  description = "Session Worker (untrusted)"
  vpc_id      = module.network.vpc_id
  tags        = { Name = "${local.prefix}-session-worker" }
}

resource "aws_security_group" "browser_worker" {
  count = local.browser_enabled ? 1 : 0

  name        = "${local.prefix}-browser-worker"
  description = "Browser Worker (Playwright MCP)"
  vpc_id      = module.network.vpc_id
  tags        = { Name = "${local.prefix}-browser-worker" }
}

resource "aws_security_group" "egress_proxy" {
  count = local.browser_proxy_enabled ? 1 : 0

  name        = "${local.prefix}-egress-proxy"
  description = "Browser egress proxy"
  vpc_id      = module.network.vpc_id
  tags        = { Name = "${local.prefix}-egress-proxy" }
}

resource "aws_security_group" "demo_api" {
  count = var.demo_internal_api_enabled ? 1 : 0

  name        = "${local.prefix}-demo-api"
  description = "Demo internal API"
  vpc_id      = module.network.vpc_id
  tags        = { Name = "${local.prefix}-demo-api" }
}

# ---- runtime-core ----

resource "aws_vpc_security_group_ingress_rule" "runtime_core_from_session_worker" {
  security_group_id            = aws_security_group.runtime_core.id
  description                  = "MCP from Session Worker"
  referenced_security_group_id = aws_security_group.session_worker.id
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
}

resource "aws_vpc_security_group_egress_rule" "runtime_core_https" {
  security_group_id = aws_security_group.runtime_core.id
  description       = "Agent Studio, AWS APIs"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "runtime_core_to_browser" {
  count = local.browser_enabled ? 1 : 0

  security_group_id            = aws_security_group.runtime_core.id
  referenced_security_group_id = aws_security_group.browser_worker[0].id
  ip_protocol                  = "tcp"
  from_port                    = 8931
  to_port                      = 8931
}

resource "aws_vpc_security_group_egress_rule" "runtime_core_to_demo_api" {
  count = var.demo_internal_api_enabled ? 1 : 0

  security_group_id            = aws_security_group.runtime_core.id
  referenced_security_group_id = aws_security_group.demo_api[0].id
  ip_protocol                  = "tcp"
  from_port                    = 8090
  to_port                      = 8090
}

resource "aws_vpc_security_group_egress_rule" "runtime_core_to_internal" {
  for_each = toset(var.allowed_internal_cidrs)

  security_group_id = aws_security_group.runtime_core.id
  description       = "Internal systems"
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 0
  to_port           = 65535
}

# ---- session-worker ----

resource "aws_vpc_security_group_egress_rule" "session_worker_https" {
  security_group_id = aws_security_group.session_worker.id
  description       = "OpenAI (restricted by DNS Firewall)"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "session_worker_to_gateway" {
  security_group_id            = aws_security_group.session_worker.id
  description                  = "Tool Gateway (MCP)"
  referenced_security_group_id = aws_security_group.runtime_core.id
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
}

# VPC の DNS（VPC の CIDR の +2）
resource "aws_vpc_security_group_egress_rule" "session_worker_dns" {
  for_each = toset(["udp", "tcp"])

  security_group_id = aws_security_group.session_worker.id
  description       = "VPC DNS"
  cidr_ipv4         = "${cidrhost(var.vpc_cidr, 2)}/32"
  ip_protocol       = each.value
  from_port         = 53
  to_port           = 53
}

# ---- browser-worker ----

resource "aws_vpc_security_group_ingress_rule" "browser_from_runtime_core" {
  count = local.browser_enabled ? 1 : 0

  security_group_id            = aws_security_group.browser_worker[0].id
  referenced_security_group_id = aws_security_group.runtime_core.id
  ip_protocol                  = "tcp"
  from_port                    = 8931
  to_port                      = 8931
}

resource "aws_vpc_security_group_egress_rule" "browser_web" {
  for_each = local.browser_enabled && var.egress_policy.mode == "legacy_direct" ? toset(["80", "443"]) : toset([])

  security_group_id = aws_security_group.browser_worker[0].id
  description       = "Web (restricted by DNS Firewall)"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.value)
  to_port           = tonumber(each.value)
}

resource "aws_vpc_security_group_egress_rule" "browser_to_proxy" {
  count = local.browser_proxy_enabled ? 1 : 0

  security_group_id            = aws_security_group.browser_worker[0].id
  description                  = "Only allowed browser egress path"
  referenced_security_group_id = aws_security_group.egress_proxy[0].id
  ip_protocol                  = "tcp"
  from_port                    = 3128
  to_port                      = 3128
}

resource "aws_vpc_security_group_ingress_rule" "proxy_from_browser" {
  count = local.browser_proxy_enabled ? 1 : 0

  security_group_id            = aws_security_group.egress_proxy[0].id
  referenced_security_group_id = aws_security_group.browser_worker[0].id
  ip_protocol                  = "tcp"
  from_port                    = 3128
  to_port                      = 3128
}

resource "aws_vpc_security_group_egress_rule" "proxy_web" {
  for_each = local.browser_proxy_enabled ? toset(["80", "443"]) : toset([])

  security_group_id = aws_security_group.egress_proxy[0].id
  description       = "Allowed web targets (FQDN enforced by proxy)"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.value)
  to_port           = tonumber(each.value)
}

# ---- demo-api ----

resource "aws_vpc_security_group_ingress_rule" "demo_api_from_runtime_core" {
  count = var.demo_internal_api_enabled ? 1 : 0

  security_group_id            = aws_security_group.demo_api[0].id
  referenced_security_group_id = aws_security_group.runtime_core.id
  ip_protocol                  = "tcp"
  from_port                    = 8090
  to_port                      = 8090
}

# 契約 §5.2 では「送信なし」だが、Fargate はイメージの pull・ログ・secrets の取得をタスクの ENI から行うため、
# 443 だけは許可する（VPC エンドポイントを使わない構成のため。宛先の名前は DNS Firewall で制限される）
resource "aws_vpc_security_group_egress_rule" "demo_api_https" {
  count = var.demo_internal_api_enabled ? 1 : 0

  security_group_id = aws_security_group.demo_api[0].id
  description       = "ECR, CloudWatch Logs, Secrets Manager"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}
