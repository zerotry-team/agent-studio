output "organization_id" {
  description = "Organizations の ID（bootstrap の ecr_pull_organization_id に使う）"
  value       = local.organization_id
}

output "account_ids" {
  description = "作成したアカウントの ID"
  value       = { for k, a in aws_organizations_account.this : k => a.id }
}

output "admin_role_arns" {
  description = "各アカウントの管理者ロール（bootstrap の assume_role_arn に使う）"
  value       = { for k, a in aws_organizations_account.this : k => "arn:aws:iam::${a.id}:role/OrganizationAccountAccessRole" }
}
