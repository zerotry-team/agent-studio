# ECS クラスター、Service Connect、タスク定義、サービス（契約 §4.2〜4.4）

resource "aws_service_discovery_http_namespace" "this" {
  name        = "${local.name}.local"
  description = "Agent Studio ${var.environment} Service Connect"
}

resource "aws_ecs_cluster" "this" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  service_connect_defaults {
    namespace = aws_service_discovery_http_namespace.this.arn
  }
}

resource "aws_cloudwatch_log_group" "ecs" {
  for_each = toset(["api", "worker", "web", "migrate"])

  name              = "/ecs/${local.name}/${each.value}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.this.arn
}

locals {
  # ---- api / worker / migrate の環境変数（§4.3） ----
  backend_environment = merge(
    {
      NODE_ENV                 = "production"
      APP_ENV                  = var.environment
      PORT                     = "3200"
      PUBLIC_BASE_URL          = local.public_url
      PUBLIC_API_BASE_URL      = local.public_url
      DB_HOST                  = aws_db_instance.this.address
      DB_PORT                  = "5432"
      DB_NAME                  = local.db_name
      DB_APP_USER              = local.db_app_user
      AUTH_MODE                = "cognito"
      COGNITO_USER_POOL_ID     = aws_cognito_user_pool.this.id
      COGNITO_CLIENT_ID        = aws_cognito_user_pool_client.web.id
      RUNTIME_SERVER_ID        = local.runtime_server_id
      SECRETS_PREFIX           = local.org_secrets_prefix
      SECRETS_KMS_KEY_ID       = aws_kms_key.this.arn
      ARTIFACTS_BUCKET         = aws_s3_bucket.artifacts.bucket
      AUDIT_EXPORT_BUCKET      = aws_s3_bucket.audit.bucket
      AGENTS_API_MODE          = var.agents_api_mode
      MANIFEST_GENERATOR_MODEL = var.manifest_generator_model
      LOG_LEVEL                = var.log_level
      AWS_REGION               = local.region
    },
    # 空のときは設定しない（アプリの既定値を使う）
    var.openai_default_model != "" ? { OPENAI_DEFAULT_MODEL = var.openai_default_model } : {},
  )

  backend_secrets = {
    DB_APP_PASSWORD           = local.secret_arn["db-app"]
    RUNTIME_TOKEN_SECRET      = local.secret_arn["runtime-token-secret"]
    ANTHROPIC_API_KEY         = local.secret_arn["anthropic-api-key"]
    QIITA_OAUTH_CLIENT_ID     = local.secret_arn["qiita-oauth-client-id"]
    QIITA_OAUTH_CLIENT_SECRET = local.secret_arn["qiita-oauth-client-secret"]
  }

  # migrate だけが RDS 管理のマスターシークレット（JSON {username,password}）を受け取る
  migrate_secrets = merge(local.backend_secrets, {
    DB_ADMIN_SECRET = aws_db_instance.this.master_user_secret[0].secret_arn
  })

  # ---- web の環境変数（§4.4） ----
  web_environment = {
    NODE_ENV          = "production"
    PORT              = "3201"
    HOSTNAME          = "0.0.0.0"
    APP_BASE_URL      = local.public_url
    API_INTERNAL_URL  = "http://api:3200"
    AUTH_MODE         = "cognito"
    COGNITO_DOMAIN    = local.cognito_domain_url
    COGNITO_CLIENT_ID = aws_cognito_user_pool_client.web.id
  }

  web_secrets = {
    COGNITO_CLIENT_SECRET = local.secret_arn["cognito-client-secret"]
    SESSION_SECRET        = local.secret_arn["web-session-secret"]
    QIITA_OAUTH_CLIENT_ID = local.secret_arn["qiita-oauth-client-id"]
  }

  api_healthcheck_js = "fetch('http://127.0.0.1:3200/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

  log_configuration = {
    for k, g in aws_cloudwatch_log_group.ecs : k => {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = g.name
        "awslogs-region"        = local.region
        "awslogs-stream-prefix" = k
      }
    }
  }

  backend_environment_list = [for k, v in local.backend_environment : { name = k, value = v }]
  backend_secrets_list     = [for k, v in local.backend_secrets : { name = k, valueFrom = v }]
}

# ---- api ----

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.api_cpu)
  memory                   = tostring(var.api_memory)
  execution_role_arn       = module.exec_app.arn
  task_role_arn            = aws_iam_role.app_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = "api"
    image     = local.api_image
    essential = true
    portMappings = [{
      name          = "http"
      containerPort = 3200
      protocol      = "tcp"
      appProtocol   = "http"
    }]
    environment = local.backend_environment_list
    secrets     = local.backend_secrets_list
    healthCheck = {
      command     = ["CMD", "node", "-e", local.api_healthcheck_js]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }
    linuxParameters  = { initProcessEnabled = true }
    logConfiguration = local.log_configuration["api"]
  }])
}

resource "aws_ecs_service" "api" {
  name                   = "${local.name}-api"
  cluster                = aws_ecs_cluster.this.id
  task_definition        = aws_ecs_task_definition.api.arn
  desired_count          = local.services_enabled ? var.api_desired_count : 0
  launch_type            = "FARGATE"
  platform_version       = "LATEST"
  enable_execute_command = false
  propagate_tags         = "SERVICE"

  health_check_grace_period_seconds  = 60
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = module.network.private_subnet_ids
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3200
  }

  # web から http://api:3200 で呼べるようにする
  service_connect_configuration {
    enabled   = true
    namespace = aws_service_discovery_http_namespace.this.arn

    service {
      port_name      = "http"
      discovery_name = "api"

      client_alias {
        port     = 3200
        dns_name = "api"
      }
    }
  }

  depends_on = [aws_lb_listener_rule.api]
}

# Human Login Relayはprocess内でWebSocket peerをpairするため常に1 task。
# max=100/min=0で更新中の旧新task同時稼働を避け、split-brainを防ぐ。
# 切断したRuntimeと利用者は新taskへ自動再接続する。
resource "aws_ecs_service" "relay" {
  name                   = "${local.name}-relay"
  cluster                = aws_ecs_cluster.this.id
  task_definition        = aws_ecs_task_definition.api.arn
  desired_count          = local.services_enabled ? 1 : 0
  launch_type            = "FARGATE"
  platform_version       = "LATEST"
  enable_execute_command = false
  propagate_tags         = "SERVICE"

  health_check_grace_period_seconds  = 60
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = module.network.private_subnet_ids
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.relay.arn
    container_name   = "api"
    container_port   = 3200
  }

  depends_on = [aws_lb_listener_rule.relay]
}

# ---- worker（api イメージを command で切り替える。コンテナ名は契約 §4.2 に合わせて api） ----

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.worker_cpu)
  memory                   = tostring(var.worker_memory)
  execution_role_arn       = module.exec_app.arn
  task_role_arn            = aws_iam_role.app_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name             = "api"
    image            = local.api_image
    essential        = true
    command          = ["node", "dist/worker.js"]
    environment      = local.backend_environment_list
    secrets          = local.backend_secrets_list
    linuxParameters  = { initProcessEnabled = true }
    logConfiguration = local.log_configuration["worker"]
  }])
}

resource "aws_ecs_service" "worker" {
  name                   = "${local.name}-worker"
  cluster                = aws_ecs_cluster.this.id
  task_definition        = aws_ecs_task_definition.worker.arn
  desired_count          = local.services_enabled ? var.worker_desired_count : 0
  launch_type            = "FARGATE"
  platform_version       = "LATEST"
  enable_execute_command = false
  propagate_tags         = "SERVICE"

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = module.network.private_subnet_ids
    security_groups  = [aws_security_group.worker.id]
    assign_public_ip = false
  }
}

# ---- web ----

resource "aws_ecs_task_definition" "web" {
  family                   = "${local.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.web_cpu)
  memory                   = tostring(var.web_memory)
  execution_role_arn       = module.exec_web.arn
  task_role_arn            = aws_iam_role.web_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = "web"
    image     = local.web_image
    essential = true
    portMappings = [{
      name          = "http"
      containerPort = 3201
      protocol      = "tcp"
      appProtocol   = "http"
    }]
    environment      = [for k, v in local.web_environment : { name = k, value = v }]
    secrets          = [for k, v in local.web_secrets : { name = k, valueFrom = v }]
    linuxParameters  = { initProcessEnabled = true }
    logConfiguration = local.log_configuration["web"]
  }])
}

resource "aws_ecs_service" "web" {
  name                   = "${local.name}-web"
  cluster                = aws_ecs_cluster.this.id
  task_definition        = aws_ecs_task_definition.web.arn
  desired_count          = local.services_enabled ? var.web_desired_count : 0
  launch_type            = "FARGATE"
  platform_version       = "LATEST"
  enable_execute_command = false
  propagate_tags         = "SERVICE"

  health_check_grace_period_seconds  = 60
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = module.network.private_subnet_ids
    security_groups  = [aws_security_group.web.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3201
  }

  # クライアントとしてだけ参加する（api を名前で解決する）
  service_connect_configuration {
    enabled   = true
    namespace = aws_service_discovery_http_namespace.this.arn
  }

  # Service Connect のクライアントは起動時点の名前空間しか見えないため、api を先に作る
  depends_on = [aws_lb_listener_rule.web, aws_ecs_service.api]
}

# ---- migrate（サービスなし。CI/CD が run-task する。コンテナ名は api） ----

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.migrate_cpu)
  memory                   = tostring(var.migrate_memory)
  execution_role_arn       = module.exec_migrate.arn
  task_role_arn            = aws_iam_role.migrate_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = "api"
    image     = local.migrate_image
    essential = true
    command   = ["node", "dist/scripts/migrate.js"]
    environment = concat(
      local.backend_environment_list,
      var.initial_admin_email != "" ? [{ name = "INITIAL_PLATFORM_ADMIN_EMAIL", value = var.initial_admin_email }] : [],
    )
    secrets          = [for k, v in local.migrate_secrets : { name = k, valueFrom = v }]
    logConfiguration = local.log_configuration["migrate"]
  }])
}
