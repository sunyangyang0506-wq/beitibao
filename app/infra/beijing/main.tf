terraform {
  required_version = ">= 1.9, < 2"
  required_providers {
    alicloud = {
      source  = "aliyun/alicloud"
      version = "1.285.0"
    }
  }
}

provider "alicloud" {
  region = "cn-beijing"
}

data "alicloud_account" "caller" {}

locals {
  region = "cn-beijing"
  prefix = "beitibao-${var.environment}-${var.suffix}"
  zones  = { for index, zone in var.zones : tostring(index) => zone }
}

resource "alicloud_vpc" "service" {
  vpc_name   = local.prefix
  cidr_block = var.vpc_cidr

  lifecycle {
    precondition {
      condition     = data.alicloud_account.caller.id == var.account_id
      error_message = "The configured provider account does not match the approved target account."
    }
  }
}

resource "alicloud_vswitch" "service" {
  for_each     = local.zones
  vswitch_name = "${local.prefix}-${each.key}"
  vpc_id       = alicloud_vpc.service.id
  zone_id      = each.value
  cidr_block   = cidrsubnet(var.vpc_cidr, 8, tonumber(each.key))
}

resource "alicloud_security_group" "function" {
  security_group_name = local.prefix
  vpc_id              = alicloud_vpc.service.id
}

resource "alicloud_db_instance" "service" {
  instance_name            = local.prefix
  engine                   = "PostgreSQL"
  engine_version           = "16.0"
  category                 = var.rds_postpaid_instance_class == null ? "serverless_standard" : "HighAvailability"
  instance_charge_type     = var.rds_postpaid_instance_class == null ? "Serverless" : "Postpaid"
  instance_type            = coalesce(var.rds_postpaid_instance_class, "pg.n2.serverless.2c")
  instance_storage         = 20
  db_instance_storage_type = "cloud_essd"
  vpc_id                   = alicloud_vpc.service.id
  vswitch_id               = join(",", [for subnet in alicloud_vswitch.service : subnet.id])
  zone_id                  = var.zones[0]
  zone_id_slave_a          = var.zones[1]
  security_ips             = [for subnet in alicloud_vswitch.service : subnet.cidr_block]
  deletion_protection      = true

  dynamic "serverless_config" {
    for_each = var.rds_postpaid_instance_class == null ? [1] : []
    content {
      min_capacity = var.exam_window ? 2 : 0.5
      max_capacity = 8
      auto_pause   = false
    }
  }
}

resource "alicloud_db_backup_policy" "service" {
  instance_id                 = alicloud_db_instance.service.id
  preferred_backup_period     = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
  preferred_backup_time       = "19:00Z-20:00Z"
  backup_retention_period     = 14
  enable_backup_log           = true
  log_backup_retention_period = 14
}

resource "alicloud_oss_bucket" "papers" {
  bucket        = "${local.prefix}-papers"
  storage_class = "Standard"
  force_destroy = false

  lifecycle {
    ignore_changes = [versioning, cors_rule, server_side_encryption_rule]
  }
}

resource "alicloud_oss_bucket_public_access_block" "papers" {
  bucket              = alicloud_oss_bucket.papers.bucket
  block_public_access = true
}

resource "alicloud_oss_bucket_versioning" "papers" {
  bucket = alicloud_oss_bucket.papers.bucket
  status = "Enabled"

  depends_on = [alicloud_oss_bucket_public_access_block.papers]
}

resource "alicloud_oss_bucket_server_side_encryption" "papers" {
  bucket        = alicloud_oss_bucket.papers.bucket
  sse_algorithm = "AES256"

  depends_on = [alicloud_oss_bucket_versioning.papers]
}

resource "alicloud_oss_bucket_cors" "papers" {
  bucket        = alicloud_oss_bucket.papers.bucket
  response_vary = true
  cors_rule {
    allowed_origins = [var.web_origin]
    allowed_methods = ["POST", "GET", "HEAD"]
    allowed_headers = ["content-type", "content-md5", "x-oss-*"]
    expose_header   = ["ETag", "x-oss-version-id", "x-oss-request-id"]
    max_age_seconds = 300
  }

  depends_on = [alicloud_oss_bucket_server_side_encryption.papers]
}

resource "alicloud_message_service_queue" "tasks" {
  queue_name               = "${local.prefix}-tasks"
  maximum_message_size     = 4096
  visibility_timeout       = 360
  message_retention_period = 604800
  polling_wait_seconds     = 20
  dlq_policy {
    enabled                  = true
    dead_letter_target_queue = alicloud_message_service_queue.dead_letter.queue_name
    max_receive_count        = 5
  }
}

resource "alicloud_message_service_queue" "dead_letter" {
  queue_name               = "${local.prefix}-dead-letter"
  maximum_message_size     = 65536
  message_retention_period = 604800
}

resource "alicloud_message_service_queue" "practice" {
  queue_name               = "${local.prefix}-practice"
  maximum_message_size     = 1024
  visibility_timeout       = 90
  message_retention_period = 604800
  polling_wait_seconds     = 1
  dlq_policy {
    enabled                  = true
    dead_letter_target_queue = alicloud_message_service_queue.dead_letter.queue_name
    max_receive_count        = 5
  }
}

resource "alicloud_log_project" "service" {
  project_name = local.prefix
}

resource "alicloud_log_store" "service" {
  project_name     = alicloud_log_project.service.project_name
  logstore_name    = "smoke"
  retention_period = 30
  shard_count      = 2
  auto_split       = false
}

resource "alicloud_fcv3_function" "smoke" {
  function_name        = "${local.prefix}-smoke"
  runtime              = "custom-container"
  handler              = "index.handler"
  cpu                  = 0.5
  memory_size          = 512
  disk_size            = 512
  timeout              = 30
  instance_concurrency = 4
  internet_access      = false
  role                 = var.fc_role_arn

  custom_container_config {
    image = replace(var.smoke_image, "@sha256:", ":sha256-")
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
    logstore               = alicloud_log_store.service.logstore_name
    enable_request_metrics = true
  }
}

resource "alicloud_fcv3_trigger" "smoke" {
  function_name = alicloud_fcv3_function.smoke.function_name
  trigger_name  = "signed-http"
  trigger_type  = "http"
  qualifier     = "LATEST"
  trigger_config = jsonencode({
    authType           = "function"
    methods            = ["GET"]
    disableURLInternet = true
  })

  depends_on = [data.alicloud_fcv3_functions.verified_images]
}

resource "alicloud_event_bridge_event_bus" "service" {
  event_bus_name = local.prefix
}

resource "alicloud_event_bridge_event_source_v2" "queue" {
  count                  = var.enable_queue_smoke ? 1 : 0
  event_bus_name         = alicloud_event_bridge_event_bus.service.event_bus_name
  event_source_name      = "beitibao.queue.smoke"
  linked_external_source = true

  source_mns_parameters {
    queue_name       = alicloud_message_service_queue.tasks.queue_name
    region_id        = local.region
    is_base64_decode = true
  }
}

resource "alicloud_event_bridge_rule" "queue" {
  count          = var.enable_queue_smoke ? 1 : 0
  event_bus_name = alicloud_event_bridge_event_bus.service.event_bus_name
  rule_name      = "queue-smoke"
  filter_pattern = jsonencode({ source = [alicloud_event_bridge_event_source_v2.queue[0].event_source_name] })
  status         = "ENABLE"

  targets {
    target_id           = "smoke"
    type                = "acs.fc.function"
    endpoint            = alicloud_fcv3_function.smoke.function_arn
    push_retry_strategy = "BACKOFF_RETRY"
    dead_letter_queue {
      arn = "acs:mns:${local.region}:${var.account_id}:queues/${alicloud_message_service_queue.dead_letter.queue_name}"
    }
    param_list {
      resource_key = "functionName"
      form         = "CONSTANT"
      value        = alicloud_fcv3_function.smoke.function_name
    }
    param_list {
      resource_key = "Qualifier"
      form         = "CONSTANT"
      value        = "LATEST"
    }
    param_list {
      resource_key = "InvocationType"
      form         = "CONSTANT"
      value        = "Sync"
    }
    param_list {
      resource_key = "DataFormat"
      form         = "CONSTANT"
      value        = "Object"
    }
    param_list {
      resource_key = "Body"
      form         = "ORIGINAL"
    }
  }

  depends_on = [data.alicloud_fcv3_functions.verified_images]
}

output "resource_ids" {
  value = {
    function     = alicloud_fcv3_function.smoke.function_name
    private_db   = alicloud_db_instance.service.connection_string
    object_store = alicloud_oss_bucket.papers.bucket
    tasks        = alicloud_message_service_queue.tasks.queue_name
    practice     = alicloud_message_service_queue.practice.queue_name
    dead_letter  = alicloud_message_service_queue.dead_letter.queue_name
  }
}
