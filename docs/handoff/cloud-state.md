# 北京预发的当前状态

核验于 2026-11-10 12:48–12:58 北京时间完成。目标为华北 2（北京）的 `beitibao-staging-bja7eeaf1e`。CLI 使用本机已有的预发引导 profile，STS 返回的账号与目标匹配。结论分为云 API 实时回读、本站 HTTPS 探测和历史验收。[脱敏回读记录](evidence/cloud-2026-11-10.json)

| 范围 | 本次观测 | 验收边界 |
| --- | --- | --- |
| 函数计算与镜像 | API、7 个 Worker、1 个探针均为 `Active`，最近一次更新均为 `Successful`。8 个应用函数使用同一发布镜像，摘要以 `62e4a5bd8a3f` 开头。API 回传了实际解析的镜像字段并已配置 VPC。 | API 的发布别名列表为空。触发器列表查询返回 403 `AccessDenied`，原因是该操作需要的 `AliyunServiceRoleForFC` 访问未启用。实际触发与 Worker 当前调度待验。[FC 状态字段说明](https://help.aliyun.com/zh/functioncompute/api-fc-2023-03-30-listfunctions) |
| PostgreSQL | RDS 为 `Running`，PostgreSQL 16.0、按量高可用 `pg.n2.2c.2m`、20 GB。SSL 开启，证书到期时间为 2027-11-08 08:37:41 UTC。应用与 Worker 均存在数据库连接配置。 | 2026-11-08 的签名探针以 `verify-full` 协商 TLS 1.3，当时执行了 30 个迁移。当前源码含迁移 039，预发实际迁移号及当前连接可用性待现场验证。 |
| OSS | 实时读取到目标桶元数据，ACL 为 `private`。 | 历史验收包括匿名 403、AES256、版本读回、合成对象版本删除。当前读取的是桶元数据，版本操作本轮沿用历史证据。 |
| SMQ、事件总线、日志 | 7 条目标队列的属性读取均返回 `ServiceInDebt`。EventBridge 总线与 SLS 项目元数据可读。 | 当前队列可用性存在服务欠费阻塞。先前签名合成消息、事件流及 SLS 回读是 11-08 的通过记录，恢复后需重验消息往返、重试和死信。 |
| 百炼与预测 | 8 个应用函数的 `BEITIBAO_ENABLE_MODELS`、`BEITIBAO_ENABLE_PREDICTIONS` 均为 0。API 的 Workspace、模型配额和日预算参数未配置，应用函数无模型 Key。 | 北京评测 Key 保存在本机。11-10 早些时候的轻量探测分别记录通用端点 `Arrearage` 与业务空间 `AccessDenied.Unpurchased`。本次云配置核验未发起模型推理。代码里的模型选择和最新质量结果见 [模型对比](../../app/eval/local-model-pilot/README.md)。 |
| 找回密码邮件 | 邮件 Worker 存在，`RECOVERY_SMTP_URL`、`RECOVERY_MAIL_FROM` 两项缺失。 | 本机测试验证了邮件替身链路，预发真投递待验。 |
| CLI 与部署身份 | 当前只读核验的 STS 身份类型为 `Account`，使用引导 profile。 | 用户在 11-08 确认专用 RAM 用户验证、绑定与授权已完成。专用身份在当前机器成功扮演部署角色的证据待补。运行角色配置保存在本机。 |
| 域名和浏览器 | API 的 `WEB_ORIGIN` 为 HTTPS 占位地址。当前账号下 `beitibao.cn` 域名列表匹配 0，云解析查询返回 `InvalidDomainName.NoExist`，FC 同名前缀自定义域名列表为空。从本机访问主域和 www 的 `/healthz` 均在 TLS 阶段结束，未收到 HTTP 响应。 | 用户最后反馈的是域名信息模板实名已提交审核。注册、实名与网站 ICP 进度分别核对，备案完成和浏览器入口可用待验证。[备案进度查询](https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/icp-progress-and-result-inquires) |

11 月 8 日的签名 FC 验收记录中，`/healthz`、`/readyz` 和首页均返回 200，默认 FC 入口曾将 HTML 作为附件。同期验证了合成 JPEG 的私有对象上传、指定版本读回、交卷与对象版本清理。该记录代表当次预发与合成材料的通过范围。当前应以本页实时结果判断入口和队列状态。[历史发布验收](../bmad/release-readiness.md)

当前发布证据仍缺少可用的预发浏览器入口、可用队列与后台调度、真实邮件、预发版本与迁移核验，以及独立授权模型盲测、峰值负载、恢复和回滚验证。模型回归和合成测试的具体通过项见 [决策与实现对照](decisions-and-coverage.md)。费用、生产数据和正式发布按用户已定的确认边界办理。

部署模板入口为 [北京环境说明](../../app/infra/beijing/README.md)。本机状态及敏感配置的定位见 [材料和恢复说明](materials.md) 和项目本机交接目录中的 `protected-deployment-index.md`。
