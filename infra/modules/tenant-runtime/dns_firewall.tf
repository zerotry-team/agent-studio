# Route 53 Resolver DNS Firewall（許可リスト方式）
# VPC 内のすべての名前解決に効くため、Session Worker だけでなく Tool Gateway・Browser Worker の通信先も
# このリストに入っている必要がある（社内システムや Browser Worker で開くサイトは extra_allowed_domains に追加する）。
# DNS を使わず IP アドレスで直接つなぐ通信は止められないため、VPC 内の到達先はセキュリティグループで制限している。

locals {
  dns_allowed_domains = distinct(concat(
    [
      "api.openai.com",
      "codex-cloud-environments.chatgpt.com",
      local.agent_studio_host,
      # ECR・S3（イメージのレイヤー）・CloudWatch Logs・Secrets Manager・SSM・ECS
      "*.amazonaws.com",
      # Cloud Map（gateway / browser / demo-api）
      "*.${local.namespace}",
    ],
    var.extra_allowed_domains,
  ))
}

resource "aws_route53_resolver_firewall_domain_list" "allow" {
  name    = "${local.prefix}-allow"
  domains = local.dns_allowed_domains
}

resource "aws_route53_resolver_firewall_domain_list" "block_all" {
  name    = "${local.prefix}-block-all"
  domains = ["*"]
}

resource "aws_route53_resolver_firewall_rule_group" "this" {
  name = local.prefix
}

resource "aws_route53_resolver_firewall_rule" "allow" {
  name                    = "allow-listed-domains"
  action                  = "ALLOW"
  firewall_domain_list_id = aws_route53_resolver_firewall_domain_list.allow.id
  firewall_rule_group_id  = aws_route53_resolver_firewall_rule_group.this.id
  priority                = 100
}

resource "aws_route53_resolver_firewall_rule" "block_all" {
  name                    = "block-everything-else"
  action                  = "BLOCK"
  block_response          = "NXDOMAIN"
  firewall_domain_list_id = aws_route53_resolver_firewall_domain_list.block_all.id
  firewall_rule_group_id  = aws_route53_resolver_firewall_rule_group.this.id
  priority                = 200
}

resource "aws_route53_resolver_firewall_rule_group_association" "this" {
  name                   = local.prefix
  firewall_rule_group_id = aws_route53_resolver_firewall_rule_group.this.id
  vpc_id                 = module.network.vpc_id
  priority               = 101
}

# DNS Firewall が応答しない場合も通さない（fail closed）
resource "aws_route53_resolver_firewall_config" "this" {
  resource_id        = module.network.vpc_id
  firewall_fail_open = "DISABLED"
}
