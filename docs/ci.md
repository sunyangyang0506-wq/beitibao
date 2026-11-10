# 合成测试 CI

`scripts/ci.sh` 与 `.github/workflows/ci.yml` 提供同一套验证入口。GitHub 拉取请求或手动触发后，在一次性托管 runner 上运行合成测试，不部署或操作生产数据。实际结果以该提交对应的 Actions 运行记录为准。

## 运行

在**独立、可丢弃的代码副本**中，以普通用户运行。脚本会通过 `npm ci` 重建两端 `node_modules`，并更新构建产物，不应在正在运行服务或其他开发任务的目录执行。

需要 Node.js 22+（工作流使用 24）、原生 PostgreSQL **16** 完整工具链，以及 Poppler。Ubuntu 24.04 的安装方式写在工作流中。PostgreSQL 的 `bin` 目录须在 `PATH` 中，例如：

```sh
export PATH="/usr/lib/postgresql/16/bin:$PATH"
bash scripts/ci.sh --check-prerequisites
bash scripts/ci.sh
```

仅验证入口自身的防护及命令编排，不需要 PostgreSQL：

```sh
node --test scripts/ci.test.mjs
```

此项使用命令替身，不能代替原生数据库集成测试。

## 覆盖

1. 根据两端锁文件安装依赖；运行 CI 入口自身的回归测试。
2. 后端 TypeScript 检查、完整 `npm test` 与既有行覆盖率门槛（80%）。默认测试中包含题目版本迁移回归。
3. 单独运行同校复用集成测试（它的 `.integration.mjs` 文件名不被默认测试通配符包含）。
4. 运行合成旧版数据迁移、备份与恢复校验（`--release-restore`，包含升级校验）。
5. 前端单元测试、演示版构建、Sites 打包测试，以及 connected 模式构建。

每次数据库测试复用 `app/scripts/test-local.sh`，新建自己的 `/tmp/beitibao-pg.*` 数据目录和 Unix socket。PostgreSQL 不监听 TCP；迁移管理员、API 和各 worker 使用独立角色，测试结束清理临时集群。CI 不连接已有数据库，也不提供外部服务的凭据。数据库测试失败、覆盖率不足或任一构建失败都会使工作流失败，不跳过、不降级到数据库替身。

## 安全范围与限制

- 工作流仅支持拉取请求和手动触发，不使用 `pull_request_target`，没有部署、推送或上传产物步骤。GitHub token 只有读取代码权限，checkout 不保留凭据。
- 使用临时 HOME 与环境变量白名单，不继承数据库、百炼、阿里云、SMTP、npm 认证或 Node 预加载配置。拒绝构建可能被自动加载的本地 `.env` 文件，不读取用户 HOME 中的配置文件。
- 模型、对象存储、队列及邮件测试使用合成数据与测试替身。不运行真实模型冒烟、私有原卷评测、北京部署或收费服务。
- 依赖安装需要网络；该脚本不是操作系统网络沙箱，测试代码仍需正常代码审查。只能在可信代码副本或无生产权限的临时 CI runner 上运行，不能挂载生产密钥、私有原卷或用户数据。
- 没有浏览器验收、真实模型质量门槛、生产性能指标或云端发布证明。通过本工作流不代表已达到上线标准。
- 最初的本地验证环境没有原生 PostgreSQL 16，也没有 Docker/Podman。该环境通过的定向测试不能代替本工作流的原生数据库阶段；以当前提交的实际测试日志为准。
