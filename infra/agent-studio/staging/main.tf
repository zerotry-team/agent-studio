# Agent Studio staging（最小構成: NAT 1 台、RDS はシングル AZ）

module "control_plane" {
  source = "../../modules/control-plane"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  environment = local.environment

  vpc_cidr          = "10.20.0.0/16"
  nat_gateway_count = 1

  image_registry    = var.image_registry
  image_tag         = var.image_tag
  migrate_image_tag = var.migrate_image_tag

  domain_name                   = var.domain_name
  acm_certificate_arn_us_east_1 = var.acm_certificate_arn_us_east_1
  alb_certificate_arn           = var.alb_certificate_arn

  # ローカル開発の Web から staging の Cognito でログインできるようにする
  additional_callback_urls    = ["http://localhost:3201/auth/callback"]
  additional_logout_urls      = ["http://localhost:3201/"]
  cognito_deletion_protection = false

  db_instance_class        = "db.t4g.micro"
  db_multi_az              = false
  db_backup_retention_days = 7
  db_deletion_protection   = false
  db_skip_final_snapshot   = true
  db_apply_immediately     = true

  alb_deletion_protection     = false
  log_retention_days          = 30
  secret_recovery_window_days = 7

  openai_default_model     = var.openai_default_model
  manifest_generator_model = var.manifest_generator_model

  api_desired_count    = 1
  worker_desired_count = 1
  web_desired_count    = 1
}
