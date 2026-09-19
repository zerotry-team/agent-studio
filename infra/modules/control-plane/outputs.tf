# CI/CD が使う出力（名前を変えるときはワークフローも直す）

output "public_url" {
  description = "Agent Studio の公開 URL（テナントの config.yaml の agent_studio_url に使う）"
  value       = local.public_url
}

output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "api_service_name" {
  value = aws_ecs_service.api.name
}

output "worker_service_name" {
  value = aws_ecs_service.worker.name
}

output "web_service_name" {
  value = aws_ecs_service.web.name
}

output "migrate_task_definition_family" {
  value = aws_ecs_task_definition.migrate.family
}

output "migrate_security_group_id" {
  value = aws_security_group.migrate.id
}

output "private_subnet_ids" {
  value = module.network.private_subnet_ids
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.this.id
}

output "cognito_client_id" {
  value = aws_cognito_user_pool_client.web.id
}

output "cognito_domain" {
  description = "Hosted UI の URL（https://<prefix>.auth.<region>.amazoncognito.com）"
  value       = local.cognito_domain_url
}

output "runtime_server_id" {
  description = "テナントの config.yaml の runtime_server_id に使う値"
  value       = local.runtime_server_id
}

output "artifacts_bucket" {
  value = aws_s3_bucket.artifacts.bucket
}

output "audit_bucket" {
  value = aws_s3_bucket.audit.bucket
}

output "deployed_image_tag_parameter" {
  description = "デプロイ済みのイメージタグを記録する SSM パラメータの名前"
  value       = aws_ssm_parameter.deployed_image_tag.name
}

# ---- 以下は運用の参考 ----

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.this.id
}

output "cloudfront_domain_name" {
  description = "独自ドメインを使う場合は、この名前への ALIAS / CNAME レコードを作る"
  value       = aws_cloudfront_distribution.this.domain_name
}

output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "db_endpoint" {
  value = aws_db_instance.this.address
}

output "db_master_secret_arn" {
  value = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "kms_key_arn" {
  value = aws_kms_key.this.arn
}

output "anthropic_api_key_secret_name" {
  description = "運用者が Anthropic の API キーを設定するシークレット"
  value       = aws_secretsmanager_secret.this["anthropic-api-key"].name
}
