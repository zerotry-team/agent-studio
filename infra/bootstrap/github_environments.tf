# CI/CD が使う GitHub Environment と変数（infra/README.md「GitHub Environment の変数」）。
# 承認者（必須のレビュー）は、最初の動作確認のあとに GitHub の画面で設定することを勧める。

locals {
  github_repository_name = split("/", var.github_repository)[1]
  github_environments    = var.manage_github_environments ? toset(var.github_environments) : toset([])

  github_variables = merge(
    {
      AWS_REGION          = var.region
      AWS_DEPLOY_ROLE_ARN = aws_iam_role.github_deploy.arn
      TF_STATE_BUCKET     = aws_s3_bucket.tfstate.bucket
    },
    var.github_environment_variables,
  )

  # 公開リポジトリの Actions のログは誰でも見られる。アカウント ID をシークレットにすると、
  # それを含む値（ロールの ARN、バケット名など）もログで *** に置き換わる
  github_secret_names = var.manage_github_environments ? toset(concat(["AWS_ACCOUNT_ID"], keys(nonsensitive(var.github_environment_secrets)))) : toset([])
  github_secret_pairs = {
    for pair in setproduct(var.github_environments, tolist(local.github_secret_names)) :
    "${pair[0]}/${pair[1]}" => { environment = pair[0], name = pair[1] }
  }

  github_environment_variables = var.manage_github_environments ? {
    for pair in setproduct(var.github_environments, keys(local.github_variables)) :
    "${pair[0]}/${pair[1]}" => { environment = pair[0], name = pair[1], value = local.github_variables[pair[1]] }
  } : {}
}

resource "github_repository_environment" "this" {
  for_each = local.github_environments

  repository  = local.github_repository_name
  environment = each.value

  # 決めたブランチ（main）からしかデプロイできないようにする
  deployment_branch_policy {
    protected_branches     = false
    custom_branch_policies = true
  }
}

resource "github_repository_environment_deployment_policy" "this" {
  for_each = local.github_environments

  repository     = local.github_repository_name
  environment    = github_repository_environment.this[each.value].environment
  branch_pattern = var.github_deployment_branch
}

resource "github_actions_environment_variable" "this" {
  for_each = local.github_environment_variables

  repository    = local.github_repository_name
  environment   = github_repository_environment.this[each.value.environment].environment
  variable_name = each.value.name
  value         = each.value.value
}

resource "github_actions_environment_secret" "this" {
  for_each = local.github_secret_pairs

  repository      = local.github_repository_name
  environment     = github_repository_environment.this[each.value.environment].environment
  secret_name     = each.value.name
  plaintext_value = each.value.name == "AWS_ACCOUNT_ID" ? var.aws_account_id : var.github_environment_secrets[each.value.name]
}
