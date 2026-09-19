# IAM（契約 §5.4）

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${local.partition}:ecs:${var.region}:${local.account_id}:*"]
    }
  }
}

# ---- <prefix>-runtime（runtime-core のタスクロール。Agent Studio に登録する IAM ロール） ----

resource "aws_iam_role" "runtime" {
  name               = "${local.prefix}-runtime"
  description        = "Agent Studio Runtime Controller + Tool Gateway (registered in Agent Studio)"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "runtime" {
  statement {
    sid       = "RunSessionWorker"
    actions   = ["ecs:RunTask"]
    resources = ["arn:${local.partition}:ecs:${var.region}:${local.account_id}:task-definition/${local.prefix}-session-worker:*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.this.arn]
    }
  }

  statement {
    sid       = "ManageTasks"
    actions   = ["ecs:StopTask", "ecs:DescribeTasks"]
    resources = ["arn:${local.partition}:ecs:${var.region}:${local.account_id}:task/${local.prefix}/*"]
  }

  # ListTasks はリソースを指定できないため、クラスターの条件で限定する
  statement {
    sid       = "ListTasks"
    actions   = ["ecs:ListTasks"]
    resources = ["*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.this.arn]
    }
  }

  # RunTask でタスクにタグを付けるため
  statement {
    sid       = "TagOnRunTask"
    actions   = ["ecs:TagResource"]
    resources = ["arn:${local.partition}:ecs:${var.region}:${local.account_id}:task/${local.prefix}/*"]
    condition {
      test     = "StringEquals"
      variable = "ecs:CreateAction"
      values   = ["RunTask"]
    }
  }

  statement {
    sid       = "PassSessionWorkerRoles"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.session_worker_task.arn, module.exec_session_worker.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  statement {
    sid     = "RuntimeSecrets"
    actions = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"]
    resources = [
      aws_secretsmanager_secret.bootstrap_token.arn,
      aws_secretsmanager_secret.openai_environment_key.arn,
    ]
  }

  statement {
    sid       = "ConnectionSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["arn:${local.partition}:secretsmanager:${var.region}:${local.account_id}:secret:${local.secrets_prefix}/connections/*"]
  }

  statement {
    sid       = "ToolConfig"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.tool_config.arn]
  }

  # PutSecretValue（環境キーの書き込み）で暗号化にも使うため、Decrypt に加えて GenerateDataKey を許可する。
  # Secrets Manager 経由の利用に限る
  statement {
    sid       = "Kms"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.this.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "runtime" {
  name   = "runtime"
  role   = aws_iam_role.runtime.id
  policy = data.aws_iam_policy_document.runtime.json
}

# ---- Session Worker（タスクロールには何の権限も付けない: SEC-12） ----

resource "aws_iam_role" "session_worker_task" {
  name               = "${local.prefix}-session-worker-task"
  description        = "Session Worker (no AWS permissions)"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

module "exec_session_worker" {
  source = "../ecs-execution-role"

  name                = "${local.prefix}-session-worker-exec"
  ecr_repository_arns = [local.ecr_repository_arn["session-worker"]]
  log_group_arns      = [aws_cloudwatch_log_group.this["session-worker"].arn]
  secret_arns         = [aws_secretsmanager_secret.openai_environment_key.arn]
  kms_key_arn         = aws_kms_key.this.arn
}

# ---- 常駐サービスの実行ロール ----

module "exec_runtime_core" {
  source = "../ecs-execution-role"

  name = "${local.prefix}-runtime-exec"
  ecr_repository_arns = [
    local.ecr_repository_arn["runtime-controller"],
    local.ecr_repository_arn["tool-gateway"],
  ]
  log_group_arns = [
    aws_cloudwatch_log_group.this["controller"].arn,
    aws_cloudwatch_log_group.this["tool-gateway"].arn,
  ]
}

module "exec_browser_worker" {
  source = "../ecs-execution-role"
  count  = var.browser_enabled ? 1 : 0

  name                = "${local.prefix}-browser-exec"
  ecr_repository_arns = [local.ecr_repository_arn["browser-worker"]]
  log_group_arns      = [aws_cloudwatch_log_group.this["browser-worker"].arn]
}

module "exec_demo_internal_api" {
  source = "../ecs-execution-role"
  count  = var.demo_internal_api_enabled ? 1 : 0

  name                = "${local.prefix}-demo-api-exec"
  ecr_repository_arns = [local.ecr_repository_arn["demo-internal-api"]]
  log_group_arns      = [aws_cloudwatch_log_group.this["demo-internal-api"].arn]
  secret_arns         = [aws_secretsmanager_secret.connection["demo-internal-api"].arn]
  kms_key_arn         = aws_kms_key.this.arn
}
