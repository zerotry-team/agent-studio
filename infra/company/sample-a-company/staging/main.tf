module "runtime" {
  source = "../../../modules/tenant-runtime"

  organization_id   = local.organization_id
  runtime_id        = local.runtime_id
  tenant_short      = local.config.short_name
  stage             = local.stage
  region            = local.config.region
  agent_studio_url  = var.agent_studio_url != "" ? var.agent_studio_url : local.stage_config.agent_studio_url
  runtime_server_id = local.stage_config.runtime_server_id

  image_registry = var.image_registry
  image_tag      = var.image_tag

  vpc_cidr                  = try(local.runtime.vpc_cidr, "10.40.0.0/16")
  nat_gateway_count         = try(local.runtime.nat_gateway_count, 1)
  browser_enabled           = try(local.runtime.browser_enabled, false)
  browser_runtime           = try(local.runtime.browser_runtime, {})
  egress_policy             = try(local.runtime.egress_policy, {})
  demo_internal_api_enabled = try(local.runtime.demo_internal_api_enabled, false)
  allowed_internal_cidrs    = try(local.runtime.allowed_internal_cidrs, [])
  extra_allowed_domains     = try(local.runtime.extra_allowed_domains, [])
  session_worker            = try(local.runtime.session_worker, {})
  connections               = try(local.runtime.connections, [])
  tool_config               = try(local.runtime.tools, { version = 1 })
}
