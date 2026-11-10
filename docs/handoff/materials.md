# 材料和恢复说明

2026-11-10 已从项目现有文件归档 563 份本机材料，压缩包约 311 MB。每份文件记录相对路径、字节数和 SHA-256。打包后逐条读回核对内容，目录和包摘要见 [归档证据](evidence/materials-2026-11-10.json)。

| 材料 | 本机目录和现有证据 | 使用范围 |
| --- | --- | --- |
| 正式考试原卷及独立参考 | `app/eval/national-exam-archive/` 有 102 份原卷和 17 份独立参考 PDF，清单含来源、哈希与候选划分。另有 26 套留出卷解析清单 `app/eval/data/national-exams.json`，题目金标目前为 0。[真题档案说明](../../app/eval/national-exam-archive/README.md) | 候选卷按原项目记录保留。评测用途、第三方处理和参考答案授权按卷核实。公开下载和候选划分仅作为材料来源证据。 |
| 大学课程真实卷及候选材料 | `app/eval/source-materials/` 的各课程、开放课程和同济高数材料。归档含原文件、来源与清单。[课程覆盖](../../app/eval/university-paper-exam-scope.md) | 11-09 用户授权百炼处理当时选中的同济高数 PDF，用于那次识别和预测演示。其他同济文件及其他真实卷需各自核对授权。 |
| 中文大学选择题 | `app/eval/chinese-university-qa/` 的 C-Eval 和 CMMLU 原始分片、构建清单、训练 5,302 题、评测 6,634 题及 6,634 条对齐标签。[题库说明](../../app/eval/chinese-university-qa/README.md) | 按项目记录的 CC BY-NC-SA 4.0 范围用于非商业研究。题面与标签分开，产品评测另用授权样本。 |
| 已用真实回归原件和金标 | `app/eval/moex-2020-pilot/` 的 4 页 40 题及官方答案对照，`app/eval/urjc-2025-pilot/` 的获准使用的西语试卷拼版、裁片、转录和解答结果。[中文回归](../../app/eval/moex-2020-pilot/README.md) · [西语回归](../../app/eval/urjc-2025-pilot/README.md) | 保留两套材料各自的来源、署名、许可和试跑范围。同卷复测与独立盲测分开。 |
| 评测原始输出 | `app/eval/local-model-pilot/` 两轮模型响应、OCR、人工核对与逐题结果，及 `app/eval/` 下 408、预测和上传等原始报告。请求标识可供账单复核，原始输出随本机包保存。[汇总结果](../../app/eval/local-model-pilot/README.md) | 知识点、答案与原卷结果按材料许可取用。仓库内可直接查看汇总、代码和合成样本。 |
| 预发配置、状态与验收 | `~/.config/beitibao/staging/`，包含目标、Terraform 本机状态、变量、镜像发布、CA、验收结果。完整路径分级列在交接目录的 `protected-deployment-index.md)。[部署模板](../../app/infra/beijing/README.md) · [云端现状](cloud-state.md) | 授权部署人通过原机器的受保护目录访问。状态、连接串、云账号凭据和备案证件由对应的本机目录或云控制台管理。 |

本机交接目录为项目下的 `handoff/2026-11-10-beitibao/`。该目录内的 `offline-materials.tar.gz` 包含上述评测原文件和原始结果，`offline-materials-manifest.json` 是逐文件清单，`offline-materials.sha256` 用于检查整包。Git 克隆提供相同的项目代码和汇总入口。接手人需要材料时，在用途与处理方获授权后，从这台 Mac 的本机交接目录取得对应子集。

从当前工作目录验证压缩包并恢复到独立目录。

```sh
handoff_dir=handoff/2026-11-10-beitibao
(cd "$handoff_dir" && shasum -a 256 -c offline-materials.sha256)
mkdir -m 700 restored-materials
tar -xzf "$handoff_dir/offline-materials.tar.gz" -C restored-materials
```

解压目录按 `app/eval/` 保留相对位置。需要复跑评测时，先核对清单和授权，再把指定子目录放进隔离的源码工作副本。连接模型前确认该命令是否发起付费请求。发布试卷、连接生产数据和正式上线遵循用户的单独确认。
