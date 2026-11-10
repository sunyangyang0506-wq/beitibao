#!/usr/bin/env bash
set -euo pipefail

missing=0
for command_name in terraform aliyun; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf '缺少部署工具：%s\n' "$command_name"
    missing=1
  fi
done

parameters=(account_id suffix vpc_cidr zones web_origin fc_role_arn smoke_image)
if [[ "${1:-}" == "--release" ]]; then parameters+=(release); fi
for parameter in "${parameters[@]}"; do
  variable_name="TF_VAR_${parameter}"
  if [[ -z "${!variable_name:-}" ]]; then
    printf '缺少目标环境配置：%s\n' "$variable_name"
    missing=1
  fi
done

if (( missing )); then
  exit 1
fi

if ! cloud_account="$(aliyun sts GetCallerIdentity --region cn-beijing 2>/dev/null | node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).AccountId ?? ""' 2>/dev/null)"; then
  printf '无法验证阿里云 CLI 登录。请在部署机配置已授权的 RAM 身份。\n'
  exit 1
fi
if [[ "$cloud_account" != "$TF_VAR_account_id" ]]; then
  printf '当前阿里云 CLI 身份与配置的目标账号不一致。\n'
  exit 1
fi

printf '北京目标账号配置预检通过。此检查不会创建资源或发布应用。\n'
