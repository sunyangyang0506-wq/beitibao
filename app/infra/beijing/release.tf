variable "release" {
  type = object({
    image          = string
    api_role_arn   = string
    job_role_arns  = map(string)
    web_trigger    = optional(bool, false)
    run_schedules  = optional(bool, false)
    enable_models  = optional(bool, false)
    enable_predict = optional(bool, false)
    aliases        = optional(map(string), {})
    alert_policy   = optional(string, "")
  })
  default = null
  validation {
    condition = var.release == null ? true : (
      can(regex("^(registry\\.cn-beijing\\.aliyuncs\\.com|crpi-[a-z0-9-]+\\.cn-beijing\\.personal\\.cr\\.aliyuncs\\.com|[a-z0-9-]+-registry\\.cn-beijing\\.cr\\.aliyuncs\\.com)/[a-zA-Z0-9._/-]+@sha256:[a-f0-9]{64}$", var.release.image))
      && toset(keys(var.release.job_role_arns)) == toset(["paper", "page", "solution", "prediction", "practice", "mail", "maintenance"])
      && length(distinct(concat([var.release.api_role_arn], values(var.release.job_role_arns)))) == 8
      && alltrue([for role in concat([var.release.api_role_arn], values(var.release.job_role_arns)) : can(regex("^acs:ram::${var.account_id}:role/[a-zA-Z0-9-]+$", role))])
      && (!var.release.enable_predict || var.release.enable_models)
      && alltrue([for lane, alias in var.release.aliases : contains(concat(["api"], keys(var.release.job_role_arns)), lane)
      && can(regex("^[A-Za-z][A-Za-z0-9_-]{0,63}$", alias)) && upper(alias) != "LATEST"])
      && (var.environment != "production" || (!var.release.web_trigger && !var.release.run_schedules)
      || alltrue([for lane in concat(["api"], keys(var.release.job_role_arns)) : contains(keys(var.release.aliases), lane)]))
    )
    error_message = "Use a Beijing ACR digest, separate same-account roles, and published aliases before enabling production triggers."
  }
}

locals {
  release_enabled = var.release != null
  business_lanes  = toset(["paper", "page", "solution", "prediction"])
  job_lanes       = toset(concat(tolist(local.business_lanes), ["practice", "mail", "maintenance"]))
  active_lanes = !local.release_enabled ? toset([]) : setsubtract(local.job_lanes, toset(concat(
    var.release.enable_models ? [] : ["page", "solution"],
    var.release.enable_predict ? [] : ["prediction"]
  )))
  release_common = !local.release_enabled ? {} : {
    WEB_ORIGIN                    = var.web_origin
    BEITIBAO_PRIVATE_PAPER_BUCKET = alicloud_oss_bucket.papers.bucket
    BEITIBAO_ENABLE_MODELS        = var.release.enable_models ? "1" : "0"
    BEITIBAO_ENABLE_PREDICTIONS   = var.release.enable_predict ? "1" : "0"
  }
  expected_image_digests = merge(
    { "${local.prefix}-smoke" = split("@", var.smoke_image)[1] },
    !local.release_enabled ? {} : {
      for lane in concat(["api"], tolist(local.job_lanes)) :
      "${local.prefix}-${lane}" => split("@", var.release.image)[1]
    }
  )
}

# Read FC after image updates so the check uses the newly resolved digests.
data "alicloud_fcv3_functions" "verified_images" {
  prefix     = "${local.prefix}-"
  name_regex = "^(${join("|", keys(local.expected_image_digests))})$"
  depends_on = [alicloud_fcv3_function.smoke, alicloud_fcv3_function.application, alicloud_fcv3_function.jobs]

  lifecycle {
    postcondition {
      condition = length(self.functions) == length(local.expected_image_digests) && alltrue([
        for fn in self.functions :
        try(split("@", one(fn.custom_container_config).resolved_image_uri)[1] == local.expected_image_digests[fn.function_name], false)
      ])
      error_message = "Function Compute did not resolve all of the approved image digests."
    }
  }
}

resource "alicloud_message_service_queue" "business" {
  for_each                 = local.release_enabled ? local.business_lanes : toset([])
  queue_name               = "${local.prefix}-${each.key}"
  maximum_message_size     = 1024
  visibility_timeout       = 360
  message_retention_period = 604800
  polling_wait_seconds     = 1
  dlq_policy {
    enabled                  = true
    dead_letter_target_queue = alicloud_message_service_queue.dead_letter.queue_name
    max_receive_count        = 5
  }
}

resource "alicloud_log_store" "application" {
  count            = local.release_enabled ? 1 : 0
  project_name     = alicloud_log_project.service.project_name
  logstore_name    = "application"
  retention_period = 30
  shard_count      = 2
  auto_split       = false
}

resource "alicloud_fcv3_function" "application" {
  count                = local.release_enabled ? 1 : 0
  function_name        = "${local.prefix}-api"
  runtime              = "custom-container"
  handler              = "index.handler"
  cpu                  = 1
  memory_size          = 1024
  disk_size            = 512
  timeout              = 55
  instance_concurrency = 4
  internet_access      = var.release.enable_models
  role                 = var.release.api_role_arn

  environment_variables = local.release_common
  lifecycle {
    ignore_changes = [environment_variables]
  }
  custom_container_config {
    image = replace(var.release.image, "@sha256:", ":sha256-")
    port  = 9000
    health_check_config {
      http_get_url = "/healthz"
    }
  }
  vpc_config {
    vpc_id            = alicloud_vpc.service.id
    vswitch_ids       = [for subnet in alicloud_vswitch.service : subnet.id]
    security_group_id = alicloud_security_group.function.id
  }
  log_config {
    project                = alicloud_log_project.service.project_name
    logstore               = alicloud_log_store.application[0].logstore_name
    enable_request_metrics = true
  }
}

resource "alicloud_fcv3_trigger" "application" {
  count         = !local.release_enabled ? 0 : var.release.web_trigger ? 1 : 0
  function_name = alicloud_fcv3_function.application[0].function_name
  trigger_name  = "web"
  trigger_type  = "http"
  qualifier     = lookup(var.release.aliases, "api", "LATEST")
  trigger_config = jsonencode({
    authType           = "anonymous"
    methods            = ["GET", "HEAD", "OPTIONS", "POST"]
    disableURLInternet = false
  })

  depends_on = [data.alicloud_fcv3_functions.verified_images]
}

resource "alicloud_fcv3_function" "jobs" {
  for_each             = local.release_enabled ? local.job_lanes : toset([])
  function_name        = "${local.prefix}-${each.key}"
  runtime              = "custom-container"
  handler              = "index.handler"
  cpu                  = 1
  memory_size          = 1024
  disk_size            = 512
  timeout              = contains(["paper", "page", "prediction"], each.key) ? 240 : 90
  instance_concurrency = 1
  internet_access      = each.key != "maintenance"
  role                 = var.release.job_role_arns[each.key]

  environment_variables = merge(local.release_common, {
    BEITIBAO_JOB_KIND       = each.key
    BEITIBAO_SMQ_ACCOUNT_ID = var.account_id
    BEITIBAO_SMQ_QUEUE = each.key == "practice" ? alicloud_message_service_queue.practice.queue_name : (
      contains(local.business_lanes, each.key) ? alicloud_message_service_queue.business[each.key].queue_name : ""
    )
  })
  lifecycle {
    ignore_changes = [environment_variables]
  }
  custom_container_config {
    image      = replace(var.release.image, "@sha256:", ":sha256-")
    port       = 9000
    entrypoint = ["node", "/opt/beitibao/dist/server/release-worker.js"]
    health_check_config {
      http_get_url = "/healthz"
    }
  }
  vpc_config {
    vpc_id            = alicloud_vpc.service.id
    vswitch_ids       = [for subnet in alicloud_vswitch.service : subnet.id]
    security_group_id = alicloud_security_group.function.id
  }
  log_config {
    project                = alicloud_log_project.service.project_name
    logstore               = alicloud_log_store.application[0].logstore_name
    enable_request_metrics = true
  }
}

resource "alicloud_fcv3_trigger" "schedule" {
  for_each      = !local.release_enabled ? toset([]) : var.release.run_schedules ? local.active_lanes : toset([])
  function_name = alicloud_fcv3_function.jobs[each.key].function_name
  trigger_name  = "schedule"
  trigger_type  = "timer"
  qualifier     = lookup(var.release.aliases, each.key, "LATEST")
  trigger_config = jsonencode({
    cronExpression = each.key == "maintenance" ? "0 */15 * * * *" : "0 * * * * *"
    enable         = true
    payload        = "beitibao:${each.key}"
  })

  depends_on = [data.alicloud_fcv3_functions.verified_images]
}

output "release_functions" {
  value = local.release_enabled ? merge({ api = alicloud_fcv3_function.application[0].function_name },
  { for lane, function in alicloud_fcv3_function.jobs : lane => function.function_name }) : {}
}

resource "alicloud_log_store_index" "application" {
  count    = local.release_enabled ? 1 : 0
  project  = alicloud_log_project.service.project_name
  logstore = alicloud_log_store.application[0].logstore_name
  full_text {
    case_sensitive = true
    token          = " \\n\\t,;:[]{}()\""
  }
}

resource "alicloud_sls_alert" "application" {
  for_each = !local.release_enabled ? toset([]) : var.release.alert_policy == "" ? toset([]) : toset([
    "API_REQUEST_FAILED", "WORKER_BATCH_FAILED", "BUSINESS_QUEUE_DELIVERY_FAILED", "MODEL_BUDGET_WARNING", "PAPER_OBJECT_PURGE_RETRY"
  ])
  project_name = alicloud_log_project.service.project_name
  alert_name   = lower(replace(each.key, "_", "-"))
  display_name = each.key
  status       = "ENABLED"
  schedule {
    type     = "FixedRate"
    interval = "5m"
  }
  configuration {
    type         = "default"
    version      = "2"
    threshold    = "1"
    no_data_fire = false
    condition_configuration {
      condition = "failures > 0"
    }
    policy_configuration {
      alert_policy_id  = "sls.builtin.dynamic"
      action_policy_id = var.release.alert_policy
      repeat_interval  = "30m"
    }
    query_list {
      project        = alicloud_log_project.service.project_name
      store          = alicloud_log_store.application[0].logstore_name
      store_type     = "log"
      region         = local.region
      time_span_type = "Relative"
      start          = "-5m"
      end            = "now"
      query          = "\"${each.key}\" | SELECT count(*) AS failures"
    }
  }
  depends_on = [alicloud_log_store_index.application]
}
