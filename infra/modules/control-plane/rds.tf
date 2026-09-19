# RDS for PostgreSQL 16
# マスターユーザー（テーブル所有者、migrate だけが使う）のパスワードは RDS が Secrets Manager で管理・ローテーションする。
# アプリ用ロール agent_studio_app（RLS が効く）は migrate が as-<env>/db-app のパスワードで作る。

resource "aws_db_subnet_group" "this" {
  name       = local.name
  subnet_ids = module.network.database_subnet_ids
}

resource "aws_db_parameter_group" "this" {
  name   = "${local.name}-postgres16"
  family = "postgres16"

  # TLS 以外の接続を拒否する（アプリは SSL で接続すること）
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
}

# RDS が自動で作るロググループは保持期間が無期限になるため、先に作っておく
resource "aws_cloudwatch_log_group" "rds" {
  for_each = toset(["postgresql", "upgrade"])

  name              = "/aws/rds/instance/${local.name}/${each.value}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.this.arn
}

resource "aws_db_instance" "this" {
  identifier     = local.name
  engine         = "postgres"
  engine_version = var.db_engine_version
  instance_class = var.db_instance_class

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.this.arn

  db_name                       = local.db_name
  username                      = "as_admin"
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.this.arn
  port                          = 5432

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.this.name
  publicly_accessible    = false
  multi_az               = var.db_multi_az
  ca_cert_identifier     = "rds-ca-rsa2048-g1"

  # 時刻は UTC（JST 02:00〜02:30 にバックアップ、日曜 03:00〜04:00 にメンテナンス）
  backup_retention_period    = var.db_backup_retention_days
  backup_window              = "17:00-17:30"
  maintenance_window         = "sat:18:00-sat:19:00"
  copy_tags_to_snapshot      = true
  auto_minor_version_upgrade = true
  apply_immediately          = var.db_apply_immediately

  deletion_protection       = var.db_deletion_protection
  skip_final_snapshot       = var.db_skip_final_snapshot
  final_snapshot_identifier = var.db_skip_final_snapshot ? null : "${local.name}-final"

  performance_insights_enabled    = var.db_performance_insights_enabled
  performance_insights_kms_key_id = var.db_performance_insights_enabled ? aws_kms_key.this.arn : null

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  depends_on = [aws_cloudwatch_log_group.rds]
}
