output "state_bucket_name" {
  description = "Terraform の state バケット（GitHub Environment の変数 TF_STATE_BUCKET に設定する）"
  value       = aws_s3_bucket.tfstate.bucket
}

output "deploy_role_arn" {
  description = "GitHub Actions が引き受けるロール（GitHub Environment の変数 AWS_DEPLOY_ROLE_ARN に設定する）"
  value       = aws_iam_role.github_deploy.arn
}

output "ecr_registry" {
  description = "ECR のレジストリのホスト名（Terraform の image_registry、company 環境の IMAGE_REGISTRY に使う）"
  value       = local.ecr_registry
}

output "ecr_repository_urls" {
  description = "作成した ECR リポジトリの URL"
  value       = { for name, repo in aws_ecr_repository.this : name => repo.repository_url }
}

output "github_oidc_provider_arn" {
  value = local.github_oidc_provider_arn
}
