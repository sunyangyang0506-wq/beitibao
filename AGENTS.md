# 背题宝的 Codex 工作指南

背题宝面向笔记本浏览器，支持上传试卷、识别题目、整卷练习和按科目生成预测卷。

- 产品规则和历史设计在 `docs/bmad/`。从 `docs/handoff/README.md` 查找现行决定、设计和评测交接。
- TypeScript API、后台任务、数据库迁移和合成评测在 `app/`。React 界面在 `pc-prototype/`。
- 新功能按需使用 [项目质量模板](docs/codex-project-template/README.md)，将范围、验收和证据记录在对应的功能文档。

## 验证入口

使用 Node.js 22 或更高版本。后端集成测试需要 PostgreSQL 命令行工具和 Poppler。以下命令从仓库根目录运行。

```sh
npm --prefix app ci
npm --prefix pc-prototype ci
npm --prefix app test
npm --prefix pc-prototype run build:connected
npm --prefix pc-prototype run test:sites
```

## 实现与验收

- 优先复用现有组件和 API。涉及交互时，从正常入口在浏览器验证成功、失败和恢复场景，附关键截图。
- 涉及试卷识别或预测卷时，用固定的合成或已授权样本对照基线。检查题目、选项、答案和解析中受影响的字段，记录模型配置、失败样例和耗时。真实试卷与评测材料的处理遵循 `docs/handoff/materials.md`。
- 涉及接口、权限、后台任务或数据库时，按影响验证旧调用方、历史数据、重复提交和重试。
- 汇报实际执行的检查、结果和待验证事项。北京环境相关操作遵循仓库 README 和现有交接流程。
