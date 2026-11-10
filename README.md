# 背题宝

背题宝面向笔记本浏览器，支持上传试卷、识别题目、整卷练习和按科目生成预测卷。

从交接入口查找原产品稿、批注和设计图，核对现行决定与代码、恢复本机评测材料，并查看北京预发的实时核验记录。[项目交接](docs/handoff/README.md)

- `app/` 包含 TypeScript API、后台任务、OpenAPI、数据库迁移、测试和合成评测。
- `pc-prototype/` 包含 React 界面及演示、连接 API 两种构建入口。
- `app/infra/beijing/` 包含北京环境的 Terraform、镜像和验收脚本模板。
- `docs/bmad/` 包含产品规则、历史 PRD、架构、待办和验收记录。

本地构建需要 Node.js 22 或更高版本。后端集成测试需要 PostgreSQL 命令行工具和 Poppler。以下命令在仓库根目录运行。

```sh
npm --prefix app ci
npm --prefix pc-prototype ci
npm --prefix app test
npm --prefix pc-prototype run build:connected
npm --prefix pc-prototype run test:sites
```

仓库包含演示、合成测试样本和模型验收汇总。真实试卷、题库和原始评测结果可按授权从本机交接包恢复。部署状态和凭据由原部署环境管理。涉及费用、生产数据和正式发布的操作需先得到用户确认。[材料和恢复说明](docs/handoff/materials.md)
