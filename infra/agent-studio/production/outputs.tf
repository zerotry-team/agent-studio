# CI/CD が terraform output で読む値（名前は control-plane module と同じ）

output "public_url" {
  value = module.control_plane.public_url
}

output "cluster_name" {
  value = module.control_plane.cluster_name
}

output "api_service_name" {
  value = module.control_plane.api_service_name
}

output "worker_service_name" {
  value = module.control_plane.worker_service_name
}

output "web_service_name" {
  value = module.control_plane.web_service_name
}

output "migrate_task_definition_family" {
  value = module.control_plane.migrate_task_definition_family
}

output "migrate_security_group_id" {
  value = module.control_plane.migrate_security_group_id
}

output "private_subnet_ids" {
  value = module.control_plane.private_subnet_ids
}

output "cognito_user_pool_id" {
  value = module.control_plane.cognito_user_pool_id
}

output "cognito_client_id" {
  value = module.control_plane.cognito_client_id
}

output "cognito_domain" {
  value = module.control_plane.cognito_domain
}

output "runtime_server_id" {
  value = module.control_plane.runtime_server_id
}

output "artifacts_bucket" {
  value = module.control_plane.artifacts_bucket
}

output "audit_bucket" {
  value = module.control_plane.audit_bucket
}

output "deployed_image_tag_parameter" {
  value = module.control_plane.deployed_image_tag_parameter
}

output "cloudfront_distribution_id" {
  value = module.control_plane.cloudfront_distribution_id
}

output "cloudfront_domain_name" {
  value = module.control_plane.cloudfront_domain_name
}

output "anthropic_api_key_secret_name" {
  value = module.control_plane.anthropic_api_key_secret_name
}
