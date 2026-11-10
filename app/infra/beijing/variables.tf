variable "environment" {
  type    = string
  default = "staging"
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "Use staging or production with a separate Alibaba Cloud account and state."
  }
}

variable "suffix" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9]{6,12}$", var.suffix))
    error_message = "Use 6 to 12 lowercase letters or digits unique to this environment."
  }
}

variable "account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{16}$", var.account_id))
    error_message = "Provide the 16-digit Alibaba Cloud account UID."
  }
}

variable "vpc_cidr" {
  type = string
  validation {
    condition     = can(cidrsubnet(var.vpc_cidr, 8, 1)) && endswith(var.vpc_cidr, "/16")
    error_message = "Provide a free IPv4 /16 CIDR block for the selected environment."
  }
}

variable "zones" {
  type = list(string)
  validation {
    condition     = length(var.zones) == 2 && length(distinct(var.zones)) == 2 && alltrue([for zone in var.zones : can(regex("^cn-beijing-[a-z]+$", zone))])
    error_message = "Provide two distinct Beijing zones with FC and the selected RDS PostgreSQL class."
  }
}

variable "web_origin" {
  type = string
  validation {
    condition     = can(regex("^https://[a-zA-Z0-9-]+(\\.[a-zA-Z0-9-]+)+$", var.web_origin))
    error_message = "Use the exact HTTPS web origin with no path, port, or wildcard."
  }
}

variable "fc_role_arn" {
  type = string
  validation {
    condition     = can(regex("^acs:ram::${var.account_id}:role/[a-zA-Z0-9-]+$", var.fc_role_arn))
    error_message = "Use a dedicated FC RAM role from the target account."
  }
}

variable "smoke_image" {
  type = string
  validation {
    condition     = can(regex("^[a-zA-Z0-9._/-]+@sha256:[a-f0-9]{64}$", var.smoke_image))
    error_message = "Use a digest-pinned Beijing ACR image."
  }
}

variable "exam_window" {
  type    = bool
  default = false
}

variable "rds_postpaid_instance_class" {
  type        = string
  default     = null
  description = "PostgreSQL high-availability pay-as-you-go class for deployments that require database TLS."

  validation {
    condition = var.rds_postpaid_instance_class == null ? true : (
      trimspace(var.rds_postpaid_instance_class) != "" && !strcontains(lower(var.rds_postpaid_instance_class), "serverless")
    )
    error_message = "Select a non-Serverless PostgreSQL high-availability instance class."
  }
}

variable "enable_queue_smoke" {
  type    = bool
  default = false
}
