# ../config.yaml を読み、このステージ（staging）の設定を組み立てる

locals {
  stage = "staging"

  config       = yamldecode(file("${path.module}/../config.yaml"))
  stage_config = local.config.stages[local.stage]

  # staging の Agent Studio は別の DB なので、ステージ側に organization_id があればそちらを使う
  organization_id = try(local.stage_config.organization_id, local.config.organization_id)
  runtime_id      = try(local.stage_config.runtime_id, "")
  aws_account_id  = try(local.stage_config.aws_account_id, "")

  # ステージ側の runtime で 1 階層目のキーを上書きする
  runtime = merge(local.config.runtime, try(local.stage_config.runtime, {}))
}
