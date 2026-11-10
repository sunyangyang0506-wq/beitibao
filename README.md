# 背题宝

背题宝面向笔记本浏览器，支持上传试卷、识别题目、整卷练习和按科目生成预测卷。

- `app/`：TypeScript API、后台任务、OpenAPI、数据库迁移、测试和合成评测。
- `pc-prototype/`：仅面向笔记本浏览器的 React 界面，含演示和连接 API 的构建入口。
- `app/infra/beijing/`：北京环境的 Terraform、镜像和验收脚本模板。
- `docs/bmad/`：产品需求、规则、架构、待办和上线验收。先读 `prd.md`、`product-rules.md`、`development-backlog.md` 和 `release-readiness.md`。

本地构建需要 Node.js 22 或更高版本。后端集成测试需要 PostgreSQL 命令行工具和 Poppler。在仓库根目录运行：

```sh
npm --prefix app ci
npm --prefix pc-prototype ci
npm --prefix app test
npm --prefix pc-prototype run build:connected
npm --prefix pc-prototype run test:sites
```

仓库包含演示与合成测试样本，以及最近一轮模型验收的汇总分数。真实试卷、题库和原始模型评测输出存放在获准的本机环境；相应评测脚本需要在获准环境另行取得材料。生产密钥、环境文件、数据库内容、用户上传和部署状态由本机或部署环境单独管理。涉及费用、生产数据和正式发布的操作需先得到用户确认。
