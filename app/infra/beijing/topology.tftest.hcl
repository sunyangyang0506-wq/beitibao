mock_provider "alicloud" {
  mock_data "alicloud_account" {
    defaults = {
      id = "1234567890123456"
    }
  }
}

variables {
  account_id  = "1234567890123456"
  suffix      = "test01"
  vpc_cidr    = "10.34.0.0/16"
  zones       = ["cn-beijing-h", "cn-beijing-i"]
  web_origin  = "https://study.example.test"
  fc_role_arn = "acs:ram::1234567890123456:role/beitibao-smoke"
  smoke_image = "registry.cn-beijing.aliyuncs.com/beitibao/smoke@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}

run "private_staging" {
  command = plan

  assert {
    condition     = alicloud_oss_bucket_public_access_block.papers.block_public_access && alicloud_oss_bucket_versioning.papers.status == "Enabled"
    error_message = "Original paper storage must remain private and versioned."
  }
  assert {
    condition     = length(alicloud_vswitch.service) == 2 && alicloud_db_instance.service.deletion_protection
    error_message = "Database networking must use two explicit subnets and deletion protection."
  }
  assert {
    condition     = length(alicloud_event_bridge_rule.queue) == 0 && jsondecode(alicloud_fcv3_trigger.smoke.trigger_config).authType == "function"
    error_message = "Staging must default to a signed HTTP trigger and an idle queue."
  }
  assert {
    condition     = one(alicloud_fcv3_function.smoke.custom_container_config).image == replace(var.smoke_image, "@sha256:", ":sha256-")
    error_message = "The smoke function must use the tag derived from the verified digest."
  }
}

run "queue_smoke_and_exam_capacity" {
  command = plan
  variables {
    enable_queue_smoke = true
    exam_window        = true
  }
  assert {
    condition     = length(alicloud_event_bridge_rule.queue) == 1 && alicloud_message_service_queue.tasks.visibility_timeout == 360
    error_message = "The selected smoke topology must include a queue and event delivery."
  }
  assert {
    condition = anytrue([
      for param in one(one(alicloud_event_bridge_rule.queue).targets).param_list :
      param.resource_key == "functionName" && param.value == alicloud_fcv3_function.smoke.function_name
    ])
    error_message = "EventBridge must receive the target FC function name."
  }
  assert {
    condition     = one(alicloud_db_instance.service.serverless_config).min_capacity == 2
    error_message = "The exam window must raise the database minimum capacity."
  }
}

run "release_application_and_workers" {
  command = plan
  variables {
    rds_postpaid_instance_class = "pg.n2.2c.2m"
    release = {
      image        = "crpi-example.cn-beijing.personal.cr.aliyuncs.com/beitibao/release@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      api_role_arn = "acs:ram::1234567890123456:role/beitibao-api"
      job_role_arns = {
        for lane in ["paper", "page", "solution", "prediction", "practice", "mail", "maintenance"] :
        lane => "acs:ram::1234567890123456:role/beitibao-${lane}"
      }
      run_schedules = true
      alert_policy  = "staging-ops"
    }
  }
  assert {
    condition = (alicloud_db_instance.service.category == "HighAvailability" &&
      alicloud_db_instance.service.instance_charge_type == "Postpaid" &&
      alicloud_db_instance.service.instance_type == "pg.n2.2c.2m" &&
    length(alicloud_db_instance.service.serverless_config) == 0)
    error_message = "The TLS-capable release class must use the Postpaid high-availability configuration."
  }
  assert {
    condition     = length(alicloud_fcv3_function.application) == 1 && length(alicloud_fcv3_function.jobs) == 7
    error_message = "The application release must include the API and isolated job functions."
  }
  assert {
    condition = alltrue([
      for function in concat(alicloud_fcv3_function.application, values(alicloud_fcv3_function.jobs)) :
      one(function.custom_container_config).image == replace(var.release.image, "@sha256:", ":sha256-")
    ])
    error_message = "The API and all Workers must use the tag derived from the verified release digest."
  }
  assert {
    condition     = length(alicloud_fcv3_trigger.application) == 0 && length(alicloud_fcv3_trigger.schedule) == 4
    error_message = "Model schedules and public HTTP must be disabled by default."
  }
  assert {
    condition     = alltrue([for queue in alicloud_message_service_queue.business : one(queue.dlq_policy).enabled])
    error_message = "Business queues must use dead letter delivery."
  }
  assert {
    condition     = length(alicloud_sls_alert.application) == 5
    error_message = "An approved operations policy must enable the application alerts."
  }
}
