# 背题宝北京部署

当前已建资源、运行开关和入口回读见 [北京预发当前状态](../../../docs/handoff/cloud-state.md)。授权部署人从 [本机材料索引](../../../docs/handoff/materials.md) 定位现有参数和验收记录。

Terraform 固定华北 2（北京），定义独立 VPC 和双可用区、PostgreSQL 16 高可用实例、私有版本化 OSS、SMQ 工作队列和死信队列、EventBridge 探针、FC V3 及 SLS。服务名与账号绑定。HTTP 探针使用签名认证和内网入口。

## 本地核验

```sh
terraform init -backend=false
terraform fmt -check
terraform validate
terraform test
```

两组模拟计划覆盖默认私有资源和显式启用的队列探针、考季容量。探针的健康检查和事件入口也可用本机 Node 运行。容器需在已授权的北京 ACR 构建并以摘要配置。 `smoke.mjs` 只记录探针事件 ID，便于对照 EventBridge 和 SLS。

## 目标环境参数

| 参数 | 用途 |
|---|---|
| `account_id`、`environment`、`suffix` | 账号和环境隔离。测试和生产使用独立账号与状态。Terraform 会检查实际凭据账号。 |
| `zones`、`vpc_cidr` | 提供目标账号下同时支持 FC 与所选 PostgreSQL 规格的两个北京可用区，以及未使用的地址段。 |
| `rds_postpaid_instance_class` | 需要数据库 TLS 的预发使用经确认的高可用按量规格。省略时使用 Serverless。 |
| `web_origin` | 签名直传的唯一 HTTPS 浏览器来源。 |
| `fc_role_arn`、`smoke_image` | 专用 FC RAM 角色及同地域 ACR 镜像摘要。角色仅授予目标 VPC、日志库和镜像运行所需权限。 |
| `exam_window`、`enable_queue_smoke` | 默认关闭。考期将 RCU 下限从 0.5 提至 2。队列探针使用独立队列。 |

默认配置为联通测试。提供 `release` 后可计划应用 API、业务 Worker、专用队列和日志告警。目标账号、可用区、预算、角色、镜像和状态后端核定后，先生成目标账户的计划。Serverless 的自动启停在初次创建后单独测量和配置。联通通过后，再为迁移、API 和各后台入口配置不同数据库角色。

## 接入验收

1. 在私网测 FC 冷启动和 RDS 唤醒，执行数据库点恢复演练。记录计费、RPO 和 RTO。
2. 使用测试原卷验证 OSS 签名直传、固定对象版本、跨域、签名过期和跨账号拒绝。
3. 向探针队列发送脱敏测试事件，核对 FC 与 SLS 后再开启独立业务队列。验证超时、重复消费和死信。
4. 定时交卷使用单独的 `practice` 队列。配置 `scripts/practice-queue-grants.sql`、`PRACTICE_QUEUE_DATABASE_URL`、`BEITIBAO_SMQ_ACCOUNT_ID`、`BEITIBAO_SMQ_PRACTICE_QUEUE` 和短期 RAM 凭据。用 `npm run worker:practice-queue -- publish` 投递，`consume` 消费，`repair` 扫描到期但未结算的作答。
5. 使用目标环境复验完整 B01–B12 验收指标和模型账单。生产流量发布依赖项目批准的部署与数据门槛。

[PostgreSQL Serverless](https://help.aliyun.com/zh/rds/apsaradb-rds-for-postgresql/create-a-serverless-apsaradb-rds-for-postgresql-instance) · [FC HTTP 签名](https://help.aliyun.com/zh/functioncompute/configure-signature-authentication-for-http-triggers) · [SMQ 推送到 FC](https://help.aliyun.com/zh/eventbridge/use-cases/push-events-from-simple-message-queue-formerly-mns-to-function-compute)

## 部署配置预检

在已安装 Node.js、Terraform 和阿里云 CLI 的部署机配置已授权的 RAM 身份。将上表的必填参数通过 `TF_VAR_account_id`、`TF_VAR_suffix`、`TF_VAR_vpc_cidr`、`TF_VAR_zones`、`TF_VAR_web_origin`、`TF_VAR_fc_role_arn` 和 `TF_VAR_smoke_image` 注入，`TF_VAR_zones` 使用 JSON 数组。分别为 CLI 和 Terraform 配置同一目标账号的身份，凭据留在部署机。运行 `bash preflight.sh` 验证必填项和 CLI 账号，然后用 Terraform 生成并核对计划。预检与计划均不创建云资源。

## 应用预发与发布

1. 在项目根目录用 `docker buildx build --platform linux/amd64 -f app/infra/beijing/Dockerfile.release -t <北京ACR镜像> --push .` 构建并推送已批准的发布镜像。另行构建 `Dockerfile` 中的联通探针。对两个镜像按摘要拉取，并用 `docker push --platform linux/amd64` 发布同一摘要对应的 `sha256-<64 位摘要>` 标签。推送后核对标签解析结果。Terraform 接收摘要参数，向 FC 传入该标签，并在创建后校验 FC 实际解析的摘要。构建上下文限定为应用、迁移、运行脚本和前端源码。
2. 设置 `TF_VAR_release`。必填 `image`、`api_role_arn`、`job_role_arns`。后者为 `paper`、`page`、`solution`、`prediction`、`practice`、`mail`、`maintenance` 到独立 RAM 角色的映射。用 `bash preflight.sh --release` 核对账号，查看目标环境计划并确认资源范围。默认应用 HTTP 触发器、Worker 定时和模型均关闭。
3. 分配角色。API 需要目标 OSS `papers/*` 的 `oss:PutObject` 和 `oss:GetObjectVersion`。`paper`、`page`、`solution` 需要读取对应版本。清理 Worker 需要目标桶的 `oss:ListObjectVersions` 和对应对象的 `oss:DeleteObjectVersion`。OSS 资源 ARN 的地域字段使用 `*`，桶所有者、桶名和对象前缀仍按目标环境限定。业务和交卷 Worker 只需要本队列的发送、接收及删除消息权限。另配置 FC 访问 VPC、ACR、SLS 的服务权限。为私有 RDS 地址启用云端证书，将 CA 文件提供给迁移、API 和 Worker，数据库连接串使用 `sslmode=verify-full` 并用 `sslrootcert` 指向各自运行环境中的 CA 文件。[OSS 资源授权语法](https://help.aliyun.com/zh/oss/user-guide/authorization-syntax-and-elements#resource)
4. 用独立迁移角色执行 `npm run migrate`，应用 `scripts/runtime-grants.sql`。对四种业务 Worker 分别执行 `scripts/business-worker-grants.sql`，指定 `worker_lane` 和 `worker_role`。交卷、邮件、清理分别使用 `practice-queue-grants.sql`、`mail-worker-grants.sql`、`maintenance-grants.sql`。API 的 `DATABASE_URL` 和各 Worker 的 `BEITIBAO_JOB_DATABASE_URL` 使用对应运行角色。
5. 通过 FC 部署配置注入私有连接串、邮件凭据及 `RECOVERY_TOKEN_SECRET`。用应用说明开通首位管理员和专用验收账号。Terraform 创建函数时注入公开参数，随后忽略环境变量漂移，避免计划覆盖手动管理的配置。状态与计划在受控、加密的后端管理，读取云配置后可能包含敏感环境变量。启用模型时，在相关函数配置真实北京 Workspace、API Key 和 `BAILIAN_MODEL_LIMITS_JSON`。 上线前在 API 和模型 Worker 中配置 `BAILIAN_DAILY_BUDGET_CENTS=2000`，即全站每日 20 元。预算按北京时间自然日计。格式为四个固定快照到 `{ "rpm": 正整数, "tpm": 正整数 }` 的映射，值由目标账号实测配额和留量确定。模型和预测分别通过 `BEITIBAO_ENABLE_MODELS`、`BEITIBAO_ENABLE_PREDICTIONS` 启用。环境变量与 Terraform 中的触发器选项需同步更新。
   启用客观题模型前，候选版本须在整卷回归与独立授权样卷盲测中逐项严格超过 95%，并满足适用的更高门槛。[逐项验收命令](../../eval/moex-2020-pilot/README.md#逐项验收)
6. 在预发启用 `run_schedules`，配置已批准的 HTTPS 入口。函数内提供同源静态站和 API。FC 默认浏览器域名可能强制附件下载，浏览器验收使用已配置的 HTTPS 反向代理或自定义域名。使用 `TRUSTED_PROXY_CIDRS` 时，只填已核验的代理地址段。关闭模型时，用户可上传、预览、手动核对与作答。
7. 在授权的验收账号下设置 `BEITIBAO_ACCEPTANCE_ORIGIN`、`BEITIBAO_ACCEPTANCE_EMAIL` 和 `BEITIBAO_ACCEPTANCE_PASSWORD`，运行 `node verify-release.mjs`。此脚本上传项目合成 PDF，经实际 OSS、队列和 API 完成核对、交卷和删除，并检查 HTTPS、CORS 和对象版本。再用真实设备完成多图、遮盖、原图和错误恢复的网页测试。
8. 用目标环境完成压力、恢复和回滚演练。核对 Worker 重投与死信、邮件真投递、实际配额、账单和告警。设置 `release.alert_policy` 时使用已审核的 SLS 告警动作策略。确认 SLS 可检索事件并实际触发告警。按 [项目发布门槛](../../../docs/bmad/architecture.md) 验收真实盲测和数据处理。

正式环境的入口和定时触发器绑定已发布的 FC 别名。先验证新摘要对应的函数版本，再更新各别名。在回滚演练中保留上一版已验版本，切回别名后检查队列和旧作答。数据库迁移先扩展，回滚应用时保留兼容结构。队列事件只携带 ID。重复消息由数据库租约和终态控制，投递中断时由定时 Worker 直接从数据库恢复。

试点可先用 Worker 定时拉取队列。需要在高峰扩容时，为每条启用的业务队列和交卷队列配置 EventBridge 事件流，使用 Base64 解码、完整事件、单消息或最多四条一批、同步投递，目标绑定对应 FC 版本或别名，并启用重试及死信。完成真实事件烟测后，为对应 Worker 配置 `BEITIBAO_SMQ_PUSH=1`，定时入口继续投递和补偿。同步回执由 Worker 的 `x-fc-status` 报告。按实际 RDS 连接上限和 FC 并发预算配置实例上限。 [SMQ 事件流](https://www.alibabacloud.com/help/en/eventbridge/user-guide/simple-message-queue-formerly-mns) · [FC 事件格式](https://www.alibabacloud.com/help/en/functioncompute/mns-queue-triggers)

本机可运行 `bash scripts/test-local.sh --release-browser`、`--practice-load --private` 和 `--release-restore`，工作目录为 `app/`。这些用例使用隔离数据库或对象存储替身。

[函数计算容器部署](https://www.alibabacloud.com/help/en/functioncompute/custom-container/) · [HTTP 入口和默认域名](https://www.alibabacloud.com/help/en/functioncompute/web-functions) · [版本和别名](https://www.alibabacloud.com/help/en/functioncompute/manage-aliases) · [OSS 表单签名](https://www.alibabacloud.com/help/en/oss/developer-reference/signature-version-4-recommend)
