# 背题宝应用服务

本地联调包含邀请注册、密码重设、科目进展、识卷核对、闭卷作答、错题和预测练习。开发契约在 `contracts/api.ts`，本地服务通过 `GET /openapi.json` 生成 OpenAPI。交付范围和验收证据见[本轮交付核对](../docs/bmad/delivery-verification.md)和[B01–B12 计划](../docs/bmad/implementation-plan.md)。

生产入口使用 HTTPS 来源、Secure 会话和私有 OSS。网页直传后，服务端核对长度、文件指纹和固定对象版本。应用使用受限 Worker 处理解析、模型和定时交卷。用户可将多张照片排序合卷并在浏览器内遮盖个人信息。上传后的删除会立即撤销相关应用访问，后台按版本清理对象。模型与预测入口需按发布证据启用。[北京部署与验收](infra/beijing/README.md)

## 本地验证

需要 Node.js 22+（生产计划使用 Node.js 24 LTS）、PostgreSQL 16 工具和 Poppler（`pdfinfo`、`pdftotext`、`pdftoppm`）。集成测试创建并清理独立临时数据库，通过 Unix socket 连接。

```bash
npm ci
npm run lint
npm test
bash scripts/test-local.sh --upgrade-fixture
bash scripts/test-local.sh --corpus
bash scripts/test-local.sh --practice-load
```

## 本地启动 API

先准备专用 PostgreSQL 数据库与两个不同角色。迁移角色负责建表和发邀请码；运行角色需为非表所有者、`NOSUPERUSER NOBYPASSRLS`，并且没有能继承或切换到表所有者的角色成员关系。将连接串注入 `MIGRATION_DATABASE_URL` 和 `DATABASE_URL`。

```bash
npm run migrate
psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -v app_role=beitibao_api -f scripts/runtime-grants.sql
npm run invite -- student@example.test
npm run build
LOCAL_DEVELOPMENT=1 WEB_ORIGIN=http://127.0.0.1:5173 npm start
```

将 `app_role` 改为实际运行角色。邀请码只绑定指定邮箱，24 小时有效，通过内部安全渠道交给测试人员。浏览器请求使用 `credentials: "include"`，登录或注册后从返回体获取 `csrfToken`，并在已登录写请求里携带 `X-CSRF-Token`。刷新后通过 `GET /api/v1/auth/session` 恢复令牌。进展按原卷和已确认题目计算，跨卷等价关系需人工确认。

## PC 试卷库联调

API 仅在 `LOCAL_DEVELOPMENT=1 LOCAL_PAPERS=1` 同时设置时启用本地试卷接口。以独立的本地受限角色运行解析 worker，使用迁移角色执行 `scripts/local-paper-grants.sql`，将 `worker_role` 设置为该角色，再注入 `LOCAL_PAPER_WORKER_DATABASE_URL` 并运行 `npm run worker:local`。PC 的 Vite `connected` 模式在同源代理 `/api` 到本机 3041 端口，可用 `BEITIBAO_LOCAL_API` 指定隔离联调实例。PC 目录的 `npm run build:connected` 产出同源接口版静态文件。

本地原卷存于专用 PostgreSQL。支持 PDF、JPG 和 PNG，单份最多 10 MB，PDF 最多 30 页。PDF 的可信文字页可直接提取。选择视觉处理的扫描页进入独立识别队列，核对后可整套开练。原页号保持稳定，卷面顺序、缺页状态和跨页题源单独保存。北京部署的资源定义、目标账户和验证步骤见[测试拓扑](infra/beijing/README.md)。

本地演示启用自动识别时，API 和解析 worker 均设置 `BEITIBAO_ENABLE_MODELS=1`，worker 另外读取百炼凭据。授权上传的 PDF 每页都会进入识别队列，包括含文字层的页面。整卷识别完成后自动整理题目并生成解析。同科已上传试卷处理完毕且有足够来源题时，预测卷自动排队，生成后在「考题预测」显示题面。

## 北京百炼冒烟

在百炼控制台选择**华北 2（北京）**，从业务空间管理复制评测空间的 Workspace ID，再从密钥管理创建该空间的按量付费 API Key。[获取业务空间 ID](https://help.aliyun.com/zh/model-studio/obtain-the-app-id-and-workspace-id) · [创建 API Key](https://help.aliyun.com/zh/model-studio/get-api-key/)

在 macOS 默认的 zsh 中运行。密钥输入时隐藏，文件放在项目外，供同一用户启动的 Node 进程读取。

```zsh
mkdir -p "$HOME/.config/beitibao"
chmod 700 "$HOME/.config/beitibao"
(
  umask 077
  read -r 'beitibao_workspace?北京 Workspace ID: '
  read -rs 'beitibao_key?百炼 API Key: '
  printf '\n'
  printf 'BAILIAN_WORKSPACE_ID=%s\nDASHSCOPE_API_KEY=%s\n' \
    "$beitibao_workspace" "$beitibao_key" > "$HOME/.config/beitibao/bailian.env"
  chmod 600 "$HOME/.config/beitibao/bailian.env"
)
```

从 `app/` 目录运行下面的检查。凭据检查只输出是否配置。冒烟需要准备一张只显示数字 7 的合成 PNG，脚本会发出四次真实请求，分别验证两个文本快照和两个视觉快照。

```bash
node --env-file="$HOME/.config/beitibao/bailian.env" -e 'for (const k of ["BAILIAN_WORKSPACE_ID","DASHSCOPE_API_KEY"]) console.log(k, process.env[k] ? "configured" : "missing")'
node --env-file="$HOME/.config/beitibao/bailian.env" scripts/smoke-models.mjs /path/to/synthetic-digit-7.png
```

百炼说明按量付费 API 的数据不用于模型训练，服务会依法存储调用数据。真实卷接入前，核对授权是否覆盖第三方推理与相应的数据处理。[数据隐私说明](https://help.aliyun.com/zh/model-studio/privacy-notice) · [服务形态说明](https://help.aliyun.com/zh/model-studio/what-is-model-studio)

部署时用 `TRUSTED_PROXY_CIDRS` 配置已核验的 FC 代理地址，并实测客户端 IP。`scripts/maintenance-auth.sql` 清理过期会话、限流记录和重设任务。密码重设由独立受限角色运行，需通过本机或部署环境安全注入 `RECOVERY_TOKEN_SECRET`（32 字节 Base64URL）、`RECOVERY_DATABASE_URL`、`RECOVERY_SMTP_URL`（SMTPS）、`RECOVERY_MAIL_FROM` 和 HTTPS `WEB_ORIGIN`。完成 `scripts/mail-worker-grants.sql` 后用 `npm run worker:mail` 运行邮件进程。API 与 worker 使用同一令牌密钥。已有集成测试通过本地替身接收邮件。

## 数据集与评测

[评测说明](eval/README.md)包含开发集、合成评测集、运行命令和真实盲测集入库流程。

本地图片识别接受 JPG、PNG。在解析 worker 环境设置 `BAILIAN_WORKSPACE_ID` 和 `DASHSCOPE_API_KEY` 后启动 worker。识别失败的图片可在核对页重试。修订记录可按账户导出用于识别回归，见[评测说明](eval/README.md)。

未命中的新卷由后台提取或识别，符合条件时生成原卷解答。模型请求先预占日预算，再按返回用量计费。`BAILIAN_DAILY_BUDGET_CENTS` 和 `BAILIAN_TENANT_DAILY_BUDGET_CENTS` 默认各为 100 分。未知计费请求保留预占记录以供对账。

### 同校同科复用

管理员在「账号管理」绑定已核验的学校。学员上传 PDF 时可另行授权校内共享，确认已移除个人信息。未授权的历史试卷继续按账号保存。学员可以在原卷详情撤回校内共享授权。

整文件或整卷逐页指纹命中时，后台将有效题干、答案、解析和知识点写入当前学员自己的试卷记录。多页卷仅命中部分页面时，独立题目须有相同的完整输入才能沿用解答。同校同科、教师或统考范围、目标学期、来源卷版本集合及预测规则相同，可复用已校验发布的预测卷。预测证据重新指向当前学员的原卷。

更新已有环境时应用迁移 039，并重新运行 API 和相应 Worker 的角色授权脚本。从 `app/` 执行 `npm test -- --school-reuse` 可在临时数据库中验证双账号上传、解答、预测和模型网关计量。

图片和进入视觉识别的 PDF 页保留题目区域、图表坐标、整页与裁片读数。系统从原像素或 PDF 高分辨率渲染裁切。定位、图结构或两次读数冲突时，确认题目需提交人工核对内容。重新框选后保留原坐标和原读数。每图可手动重读一次，每页最多八次。

预测练习按同科来源生成候选，校验引用、题型、重复、题面条件和答案。真机验证使用项目内合成卷。从 `app` 目录运行 `bash scripts/test-local.sh --prediction-live` 会向北京百炼发起真实请求并记录用量。

### 管理员手动开通账号

1. 以迁移角色重新应用 [runtime-grants.sql](scripts/runtime-grants.sql)，使 API 角色可写入邀请码。现有数据库无需新增迁移。
2. 用 `npm run invite -- <管理员邮箱>` 生成首个邀请码。该脚本使用 `MIGRATION_DATABASE_URL`。在站点登录页通过「接受邀请」设置管理员密码。
3. 将 API 环境变量 `ACCOUNT_ADMIN_EMAIL` 配置为该邮箱并重启 API。未配置时后台发码权限关闭。部署使用 connected 模式构建的前端。
4. 管理员访问 `/#admin`，登录并填写学员邮箱。复制页面生成的一次性邀请码，通过已有联系渠道转交。邀请码 24 小时有效，学员在登录页选择「接受邀请」并自行设置密码。
