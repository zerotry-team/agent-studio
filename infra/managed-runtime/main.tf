resource "aws_iam_service_linked_role" "ecs" {
  aws_service_name = "ecs.amazonaws.com"
  description      = "Allows ECS to manage Agent Studio Runtime resources"
}

module "runtime" {
  source = "../modules/tenant-runtime"

  organization_id   = var.organization_id
  runtime_id        = var.runtime_id
  tenant_short      = var.tenant_short
  stage             = var.stage
  region            = var.region
  agent_studio_url  = var.agent_studio_url
  runtime_server_id = var.runtime_server_id
  image_registry    = var.image_registry
  image_tag         = var.image_tag

  depends_on = [aws_iam_service_linked_role.ecs]
}
