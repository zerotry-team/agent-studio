# Agent Studio production（NAT 2 台、RDS は Multi-AZ・削除保護あり）

module "control_plane" {
  source = "../../modules/control-plane"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  environment = local.environment

  vpc_cidr          = "10.30.0.0/16"
  nat_gateway_count = 2

  image_registry    = var.image_registry
  image_tag         = var.image_tag
  migrate_image_tag = var.migrate_image_tag

  initial_admin_email = var.initial_admin_email

  domain_name                   = var.domain_name
  acm_certificate_arn_us_east_1 = var.acm_certificate_arn_us_east_1
  alb_certificate_arn           = var.alb_certificate_arn

  cognito_deletion_protection = true

  db_instance_class        = "db.t4g.small"
  db_multi_az              = true
  db_backup_retention_days = 14
  db_deletion_protection   = true
  db_skip_final_snapshot   = false
  db_apply_immediately     = false

  alb_deletion_protection     = true
  log_retention_days          = 90
  secret_recovery_window_days = 30

  openai_default_model     = var.openai_default_model
  manifest_generator_model = var.manifest_generator_model

  managed_runtime_provisioning_role_arn = var.managed_runtime_provisioning_role_arn
  managed_runtime_state_bucket          = var.managed_runtime_state_bucket
  managed_runtime_account_email_domain  = var.managed_runtime_account_email_domain

  api_desired_count    = 2
  worker_desired_count = 1
  web_desired_count    = 2
}
