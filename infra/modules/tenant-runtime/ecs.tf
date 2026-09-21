# ECS クラスター、Cloud Map、タスク定義、サービス（契約 §5.1・§5.3）

resource "aws_ecs_cluster" "this" {
  name = local.prefix

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  lifecycle {
    precondition {
      condition     = var.region == data.aws_region.current.region
      error_message = "var.region と provider のリージョンが一致していません。"
    }
  }
}

resource "aws_cloudwatch_log_group" "this" {
  for_each = toset(concat(
    ["controller", "tool-gateway", "session-worker"],
    local.browser_enabled ? ["browser-worker"] : [],
    local.browser_proxy_enabled ? ["egress-proxy"] : [],
    var.demo_internal_api_enabled ? ["demo-internal-api"] : [],
  ))

  name              = "/ecs/${local.prefix}/${each.value}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.this.arn
}

# ---- Cloud Map（<name>.<prefix>.internal） ----

resource "aws_service_discovery_private_dns_namespace" "this" {
  name        = local.namespace
  description = "Agent Studio Runtime ${local.prefix}"
  vpc         = module.network.vpc_id
}

resource "aws_service_discovery_service" "this" {
  for_each = toset(concat(
    ["gateway"],
    local.browser_proxy_enabled ? ["egress-proxy"] : [],
    var.demo_internal_api_enabled ? ["demo-api"] : [],
  ))

  name          = each.value
  force_destroy = true

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.this.id
    routing_policy = "MULTIVALUE"

    dns_records {
      type = "A"
      ttl  = 10
    }
  }

  health_check_custom_config {}
}

locals {
  log_configuration = {
    for k, g in aws_cloudwatch_log_group.this : k => {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = g.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = k
      }
    }
  }

  controller_environment = {
    AGENT_STUDIO_URL               = var.agent_studio_url
    RUNTIME_SERVER_ID              = var.runtime_server_id
    AWS_REGION                     = var.region
    BOOTSTRAP_TOKEN_SECRET_ID      = aws_secretsmanager_secret.bootstrap_token.name
    ENVIRONMENT_KEY_SECRET_ID      = aws_secretsmanager_secret.openai_environment_key.name
    ECS_CLUSTER                    = aws_ecs_cluster.this.arn
    SESSION_WORKER_TASK_DEFINITION = aws_ecs_task_definition.session_worker.family
    SESSION_WORKER_SUBNETS         = join(",", module.network.private_subnet_ids)
    SESSION_WORKER_SECURITY_GROUPS = aws_security_group.session_worker.id
    SESSION_WORKER_CONTAINER_NAME  = "session-worker"
    GATEWAY_PUBLIC_URL             = local.gateway_url
    CONTROLLER_INTERNAL_PORT       = "8081"
    MAX_CONCURRENT_SESSIONS        = tostring(var.session_worker.max_concurrent)
    SESSION_MAX_LIFETIME_MINUTES   = tostring(var.session_worker.max_lifetime_minutes)
    SESSION_IDLE_TIMEOUT_MINUTES   = tostring(var.session_worker.idle_timeout_minutes)
    BROWSER_LAUNCHER               = local.browser_enabled ? "ecs" : "disabled"
    BROWSER_WORKER_TASK_DEFINITION = local.browser_enabled ? aws_ecs_task_definition.browser_worker[0].family : ""
    BROWSER_WORKER_SUBNETS         = local.browser_enabled ? join(",", module.network.private_subnet_ids) : ""
    BROWSER_WORKER_SECURITY_GROUPS = local.browser_enabled ? aws_security_group.browser_worker[0].id : ""
    BROWSER_WORKER_CONTAINER_NAME  = "browser-session-worker"
    BROWSER_PROFILE_STORE          = local.browser_enabled ? "s3" : "disabled"
    BROWSER_PROFILE_BUCKET         = local.browser_enabled ? aws_s3_bucket.browser_profiles[0].id : ""
    BROWSER_PROFILE_KMS_KEY_ARN    = local.browser_enabled ? aws_kms_key.this.arn : ""
  }

  tool_gateway_environment = {
    PORT                      = "8080"
    TOOL_CONFIG_PARAMETER     = aws_ssm_parameter.tool_config.name
    CONNECTION_SECRETS_PREFIX = "${local.secrets_prefix}/connections/"
    CONTROLLER_INTERNAL_URL   = "http://127.0.0.1:8081"
    APPROVAL_WAIT_SECONDS     = "25"
    AWS_REGION                = var.region
    # Tool Gateway は起動時にだけ設定を読むため、設定が変わったらタスク定義を更新して再起動させる（アプリは参照しない）
    TOOL_CONFIG_SHA256 = sha256(local.tool_config_json)
  }
}

# ---- runtime-core（controller + tool-gateway。タスクロールは <prefix>-runtime） ----

resource "aws_ecs_task_definition" "runtime_core" {
  family                   = "${local.prefix}-runtime-core"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.runtime_core_cpu)
  memory                   = tostring(var.runtime_core_memory)
  execution_role_arn       = module.exec_runtime_core.arn
  task_role_arn            = aws_iam_role.runtime.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name             = "controller"
      image            = local.image["runtime-controller"]
      essential        = true
      environment      = [for k, v in local.controller_environment : { name = k, value = v }]
      linuxParameters  = { initProcessEnabled = true }
      logConfiguration = local.log_configuration["controller"]
    },
    {
      name      = "tool-gateway"
      image     = local.image["tool-gateway"]
      essential = true
      portMappings = [{
        containerPort = 8080
        protocol      = "tcp"
      }]
      environment      = [for k, v in local.tool_gateway_environment : { name = k, value = v }]
      linuxParameters  = { initProcessEnabled = true }
      logConfiguration = local.log_configuration["tool-gateway"]
    },
  ])
}

resource "aws_ecs_service" "runtime_core" {
  name                   = "${local.prefix}-runtime-core"
  cluster                = aws_ecs_cluster.this.id
  task_definition        = aws_ecs_task_definition.runtime_core.arn
  desired_count          = local.services_enabled ? 1 : 0
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
    security_groups  = [aws_security_group.runtime_core.id]
    assign_public_ip = false
  }

  # gateway.<prefix>.internal（ポート 8080）
  service_registries {
    registry_arn = aws_service_discovery_service.this["gateway"].arn
  }
}

# ---- Session Worker（サービスなし。Controller がセッションごとに RunTask する） ----

resource "aws_ecs_task_definition" "session_worker" {
  family                   = "${local.prefix}-session-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.session_worker.cpu)
  memory                   = tostring(var.session_worker.memory)
  execution_role_arn       = module.exec_session_worker.arn
  task_role_arn            = aws_iam_role.session_worker_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  ephemeral_storage {
    size_in_gib = 30
  }

  # REMOTE_URL / ENVIRONMENT_ID は Controller が RunTask の containerOverrides で渡す
  container_definitions = jsonencode([{
    name      = "session-worker"
    image     = local.image["session-worker"]
    essential = true
    environment = [
      { name = "WORKSPACE_DIRECTORY", value = "/workspace" },
    ]
    secrets = [
      { name = "CODEX_API_KEY", valueFrom = aws_secretsmanager_secret.openai_environment_key.arn },
    ]
    linuxParameters  = { initProcessEnabled = true }
    logConfiguration = local.log_configuration["session-worker"]
  }])
}

# ---- Browser Worker（Playwright MCP） ----

resource "aws_ecs_task_definition" "browser_worker" {
  count = local.browser_enabled ? 1 : 0

  family                   = "${local.prefix}-browser-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.browser_runtime.cpu)
  memory                   = tostring(var.browser_runtime.memory)
  execution_role_arn       = module.exec_browser_worker[0].arn
  task_role_arn            = aws_iam_role.browser_worker_task[0].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  ephemeral_storage {
    size_in_gib = var.browser_runtime.ephemeral_storage_gib
  }

  container_definitions = jsonencode([{
    name      = "browser-session-worker"
    image     = local.image["browser-worker"]
    essential = true
    portMappings = [{
      containerPort = 8931
      protocol      = "tcp"
    }]
    environment = concat(
      [{ name = "PORT", value = "8931" }],
      local.browser_proxy_enabled ? [{ name = "BROWSER_PROXY_SERVER", value = "http://egress-proxy.${local.namespace}:3128" }] : [],
    )
    readonlyRootFilesystem = true
    user                   = "1001"
    privileged             = false
    linuxParameters = {
      initProcessEnabled = true
      capabilities       = { drop = ["ALL"] }
    }
    logConfiguration = local.log_configuration["browser-worker"]
  }])
}

# ---- Egress Proxy（Browserからの唯一のInternet出口） ----

resource "aws_ecs_task_definition" "egress_proxy" {
  count = local.browser_proxy_enabled ? 1 : 0

  family                   = "${local.prefix}-egress-proxy"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = module.exec_egress_proxy[0].arn
  task_role_arn            = aws_iam_role.egress_proxy_task[0].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = "egress-proxy"
    image     = local.image["egress-proxy"]
    essential = true
    portMappings = [{
      containerPort = 3128
      protocol      = "tcp"
    }]
    environment = [
      { name = "PORT", value = "3128" },
      { name = "ALLOWED_DOMAINS", value = join(",", var.egress_policy.allowed_domains) },
    ]
    readonlyRootFilesystem = true
    user                   = "1000"
    privileged             = false
    linuxParameters = {
      initProcessEnabled = true
      capabilities       = { drop = ["ALL"] }
    }
    logConfiguration = local.log_configuration["egress-proxy"]
  }])

  lifecycle {
    precondition {
      condition     = length(var.egress_policy.allowed_domains) > 0
      error_message = "egress_policy.mode=proxy の場合は allowed_domains を1件以上指定してください。"
    }
  }
}

resource "aws_ecs_service" "egress_proxy" {
  count = local.browser_proxy_enabled ? 1 : 0

  name                   = "${local.prefix}-egress-proxy"
  cluster                = aws_ecs_cluster.this.id
  task_definition        = aws_ecs_task_definition.egress_proxy[0].arn
  desired_count          = local.services_enabled ? 1 : 0
  launch_type            = "FARGATE"
  platform_version       = "LATEST"
  enable_execute_command = false
  propagate_tags         = "SERVICE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = module.network.private_subnet_ids
    security_groups  = [aws_security_group.egress_proxy[0].id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.this["egress-proxy"].arn
  }
}

# ---- 社内 API のモック（受け入れシナリオ用） ----

resource "aws_ecs_task_definition" "demo_internal_api" {
  count = var.demo_internal_api_enabled ? 1 : 0

  family                   = "${local.prefix}-demo-internal-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.demo_internal_api_cpu)
  memory                   = tostring(var.demo_internal_api_memory)
  execution_role_arn       = module.exec_demo_internal_api[0].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = "demo-internal-api"
    image     = local.image["demo-internal-api"]
    essential = true
    portMappings = [{
      containerPort = 8090
      protocol      = "tcp"
    }]
    environment = [
      { name = "PORT", value = "8090" },
    ]
    # Tool Gateway が送る Bearer トークンと同じシークレット
    secrets = [
      { name = "DEMO_API_TOKEN", valueFrom = aws_secretsmanager_secret.connection["demo-internal-api"].arn },
    ]
    linuxParameters  = { initProcessEnabled = true }
    logConfiguration = local.log_configuration["demo-internal-api"]
  }])
}

resource "aws_ecs_service" "demo_internal_api" {
  count = var.demo_internal_api_enabled ? 1 : 0

  name                   = "${local.prefix}-demo-internal-api"
  cluster                = aws_ecs_cluster.this.id
  task_definition        = aws_ecs_task_definition.demo_internal_api[0].arn
  desired_count          = local.services_enabled ? 1 : 0
  launch_type            = "FARGATE"
  platform_version       = "LATEST"
  enable_execute_command = false
  propagate_tags         = "SERVICE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = module.network.private_subnet_ids
    security_groups  = [aws_security_group.demo_api[0].id]
    assign_public_ip = false
  }

  # demo-api.<prefix>.internal（ポート 8090）
  service_registries {
    registry_arn = aws_service_discovery_service.this["demo-api"].arn
  }
}
