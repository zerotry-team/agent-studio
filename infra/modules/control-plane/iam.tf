# IAM（契約 §4.5）
#   実行ロール: イメージの pull、ログ、secrets の注入（注入するシークレットだけ読める）
#   タスクロール: api / worker は共通（as-<env>-app-task）。web と migrate は権限なし

module "exec_app" {
  source = "../ecs-execution-role"

  name                = "${local.name}-app-exec"
  ecr_repository_arns = [local.ecr_repository_arn["api"]]
  log_group_arns      = [aws_cloudwatch_log_group.ecs["api"].arn, aws_cloudwatch_log_group.ecs["worker"].arn]
  secret_arns         = values(local.backend_secrets)
  kms_key_arn         = aws_kms_key.this.arn
}

module "exec_migrate" {
  source = "../ecs-execution-role"

  name                = "${local.name}-migrate-exec"
  ecr_repository_arns = [local.ecr_repository_arn["api"]]
  log_group_arns      = [aws_cloudwatch_log_group.ecs["migrate"].arn]
  secret_arns         = values(local.migrate_secrets)
  kms_key_arn         = aws_kms_key.this.arn
}

module "exec_web" {
  source = "../ecs-execution-role"

  name                = "${local.name}-web-exec"
  ecr_repository_arns = [local.ecr_repository_arn["web"]]
  log_group_arns      = [aws_cloudwatch_log_group.ecs["web"].arn]
  secret_arns         = values(local.web_secrets)
  kms_key_arn         = aws_kms_key.this.arn
}

# このアカウントの ECS タスクだけが引き受けられる（confused deputy 対策）
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
      values   = ["arn:${local.partition}:ecs:${local.region}:${local.account_id}:*"]
    }
  }
}

# ---- api / worker ----

resource "aws_iam_role" "app_task" {
  name               = "${local.name}-app-task"
  description        = "Agent Studio API / Worker"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "app_task" {
  # 組織ごとの OpenAI キー（agent-studio/<env>/orgs/<organization_id>/...）だけを作成・読み書きできる
  statement {
    sid = "OrgSecrets"
    actions = [
      "secretsmanager:CreateSecret",
      "secretsmanager:PutSecretValue",
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
      "secretsmanager:TagResource",
    ]
    resources = ["arn:${local.partition}:secretsmanager:${local.region}:${local.account_id}:secret:${local.org_secrets_prefix}/orgs/*"]
  }

  statement {
    sid       = "Kms"
    actions   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.this.arn]
  }

  statement {
    sid       = "CognitoInvite"
    actions   = ["cognito-idp:AdminCreateUser", "cognito-idp:AdminGetUser"]
    resources = [aws_cognito_user_pool.this.arn]
  }

  statement {
    sid     = "Buckets"
    actions = ["s3:PutObject", "s3:GetObject"]
    resources = [
      "${aws_s3_bucket.artifacts.arn}/*",
      "${aws_s3_bucket.audit.arn}/*",
    ]
  }

  # HeadObject は対象がまだ存在しないとき、ListBucket 権限がないと 404 ではなく
  # 403 を返す。AuditExporter は未出力の時間帯を HeadObject で判定するため、
  # バケット直下の ListBucket を許可する（オブジェクトの削除権限は与えない）。
  statement {
    sid       = "ListBuckets"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.artifacts.arn, aws_s3_bucket.audit.arn]
  }
}

resource "aws_iam_role_policy" "app_task" {
  name   = "app"
  role   = aws_iam_role.app_task.id
  policy = data.aws_iam_policy_document.app_task.json
}

# WorkerだけがOrganizations管理アカウントの構築ロールを引き受けられる。
# API/Relayにはこの権限を付けず、利用者リクエストから直接AWSを変更できない境界にする。
resource "aws_iam_role" "worker_task" {
  name               = "${local.name}-worker-task"
  description        = "Agent Studio Worker (background jobs and managed Runtime provisioning)"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "worker_app" {
  name   = "app"
  role   = aws_iam_role.worker_task.id
  policy = data.aws_iam_policy_document.app_task.json
}

data "aws_iam_policy_document" "worker_provisioning" {
  count = var.managed_runtime_provisioning_role_arn != "" ? 1 : 0
  statement {
    sid       = "AssumeManagedRuntimeProvisioner"
    actions   = ["sts:AssumeRole"]
    resources = [var.managed_runtime_provisioning_role_arn]
  }
}

resource "aws_iam_role_policy" "worker_provisioning" {
  count  = var.managed_runtime_provisioning_role_arn != "" ? 1 : 0
  name   = "managed-runtime-provisioning"
  role   = aws_iam_role.worker_task.id
  policy = data.aws_iam_policy_document.worker_provisioning[0].json
}

# ---- web / migrate（権限なし） ----

resource "aws_iam_role" "web_task" {
  name               = "${local.name}-web-task"
  description        = "Agent Studio web (no AWS permissions)"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role" "migrate_task" {
  name               = "${local.name}-migrate-task"
  description        = "Agent Studio DB migration (no AWS permissions; DB secrets are injected by the execution role)"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}
