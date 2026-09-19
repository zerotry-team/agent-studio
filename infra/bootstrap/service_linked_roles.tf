# 新しいアカウントには ECS のサービスリンクロールが無く、Service Connect（Cloud Map の名前空間）を使う
# クラスターの作成が「ECS Service Linked Role is not ready」で失敗する。初期設定で先に作っておく。
resource "aws_iam_service_linked_role" "ecs" {
  count = var.create_ecs_service_linked_role ? 1 : 0

  aws_service_name = "ecs.amazonaws.com"
}
