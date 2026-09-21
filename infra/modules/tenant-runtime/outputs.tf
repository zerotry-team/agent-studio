output "prefix" {
  description = "リソース名の接頭辞（as-<tenant_short>-<stage_short>）"
  value       = local.prefix
}

output "runtime_role_name" {
  description = "Agent Studio に登録する IAM ロール名（expected_role_name）"
  value       = aws_iam_role.runtime.name
}

output "runtime_role_arn" {
  value = aws_iam_role.runtime.arn
}

output "aws_account_id" {
  description = "Agent Studio に登録する AWS アカウント ID"
  value       = local.account_id
}

output "gateway_url" {
  description = "Session Worker から見た Tool Gateway の MCP の URL"
  value       = local.gateway_url
}

output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "runtime_core_service_name" {
  value = aws_ecs_service.runtime_core.name
}

output "session_worker_task_definition_family" {
  value = aws_ecs_task_definition.session_worker.family
}

output "tool_config_parameter" {
  value = aws_ssm_parameter.tool_config.name
}

output "bootstrap_token_secret_id" {
  description = "Bootstrap Token を入れるシークレットの名前"
  value       = aws_secretsmanager_secret.bootstrap_token.name
}

output "browser_profile_bucket" {
  description = "暗号化Browser Profile本文を保存する顧客Runtime内Bucket。Browser無効時はnull。"
  value       = local.browser_enabled ? aws_s3_bucket.browser_profiles[0].id : null
}

output "connection_secret_ids" {
  description = "業務システムの認証情報を入れるシークレットの名前（接続名 → シークレット名）"
  value       = { for name, s in aws_secretsmanager_secret.connection : name => s.name }
}

locals {
  # next_steps の中で使う行（テンプレートの for / if を使うと字下げが崩れるため、先に組み立てる）
  next_steps_connections = join("\n", [
    for name, s in aws_secretsmanager_secret.connection :
    "     aws secretsmanager put-secret-value --region ${var.region} --secret-id ${s.name} --secret-string '<${name} の値>'"
  ])

  next_steps_demo_api = var.demo_internal_api_enabled ? join("\n", [
    "",
    "   demo-internal-api の値を入れたら、モックの API も再起動する（起動時にトークンを読むため）",
    "     aws ecs update-service --region ${var.region} --cluster ${aws_ecs_cluster.this.name} \\",
    "       --service ${local.prefix}-demo-internal-api --force-new-deployment",
  ]) : ""

  next_steps_image = local.services_enabled ? "" : "\n\n※ image_tag が \"none\" のため、サービスは起動していません。CI からイメージのタグを指定して適用してください。"
}

output "next_steps" {
  description = "適用後に運用者が行う作業"
  value       = <<-EOT
    ■ Runtime ${local.prefix} の適用後にやること

    1. Agent Studio の「Runtime の登録」で次の値を入力し、Bootstrap Token を発行する（有効期限 24 時間）
         AWS アカウント ID : ${local.account_id}
         IAM ロール名      : ${aws_iam_role.runtime.name}
         リージョン        : ${var.region}

    2. 発行された Bootstrap Token をこのアカウントの Secrets Manager に入れ、Runtime Controller を再起動する
       （トークンがシェルの履歴に残らないよう read -rs で入力する）
         read -rs BOOTSTRAP_TOKEN
         aws secretsmanager put-secret-value --region ${var.region} \
           --secret-id ${aws_secretsmanager_secret.bootstrap_token.name} \
           --secret-string "$BOOTSTRAP_TOKEN"
         aws ecs update-service --region ${var.region} --cluster ${aws_ecs_cluster.this.name} \
           --service ${aws_ecs_service.runtime_core.name} --force-new-deployment

    3. 業務システムの認証情報を入れる（bearer / header は値そのもの、basic は {"username":"...","password":"..."} の JSON）
    ${local.next_steps_connections}${local.next_steps_demo_api}

    4. Agent Studio に表示された Runtime ID を config.yaml の runtime_id に書き、もう一度適用する（タグに使う）${local.next_steps_image}
  EOT
}
