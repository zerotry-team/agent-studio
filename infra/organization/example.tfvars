# コピーして terraform.tfvars にし、値を書き換える（terraform.tfvars は .gitignore で除外）。

management_account_id = "000000000000"

# 管理アカウントがすでに Organizations を使っているなら false
create_organization = true

# Organizations で SCP が有効になっていないなら、組織全体の設定を変えないよう false にできる
attach_companies_scp = true

accounts = {
  "agent-studio-production" = {
    email = "aws+agent-studio-production@example.com"
    ou    = "Platform"
  }
  "sample-a-company-production" = {
    email = "aws+sample-a-company-production@example.com"
    ou    = "Companies"
  }
}
