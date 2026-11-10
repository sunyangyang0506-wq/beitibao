# 中文大学学科问答数据集

本地版本 `chinese-university-qa-v1`。采集日期为 2026-11-08。单位为题，全部是四选一的文本选择题，适用于非商业研究中的解题训练和自动评分。

| 来源 | 源学科标签数 | 训练 | 评测 |
| --- | ---: | ---: | ---: |
| C-Eval 大学级 | 25 | 717 | 5,474 |
| CMMLU 大学相关主题 | 33 | 4,585 | 1,160 |
| 合计 | 58 | 5,302 | 6,634 |

学科标签按来源分别计数，两库存在重叠主题。覆盖高等数学、大学物理、计算机网络、操作系统、法学、教育学、中文、艺术、农学、基础医学等。数据结构和矩阵等知识点分布在计算机科学、大学数学等主题中。项目的[大学纸笔考试范围](../university-paper-exam-scope.md)另有按课程登记和按原卷验收的要求。

| 文件 | 内容 |
| --- | --- |
| [train.jsonl](train.jsonl) | 每行一题，含题干、选项、答案字母和来源提供的可选解析 |
| [evaluation.jsonl](evaluation.jsonl) | 评测输入，排除独立答案和解析字段 |
| [evaluation-labels.jsonl](evaluation-labels.jsonl) | 评测答案，按 `id` 对齐后以 A/B/C/D 判分 |
| [manifest.json](manifest.json) | 按来源和学科计数、排除记录、原始文件和产物的 SHA-256 |
| [raw/](raw/) | C-Eval 大学级的 75 个 Parquet 分片、完整 CMMLU v1.0.1 ZIP 和学科名映射 |

JSONL 为 UTF-8，`options` 是以 A、B、C、D 为键的对象。`id` 的格式是 `来源/源学科ID/源划分/源行ID`，`source_split` 保留上游划分。题干、选项内的公式沿用上游文本。少数题可能依赖原始材料，采集时未逐题人工复核。

## 划分及使用范围

- C-Eval 采用项目发布的大学级学科范围。原 `dev` 和 `val` 用于训练，原 `test` 用于本地评测。
- CMMLU 按学科白名单选择 33 个大学课程相关主题。原 `dev` 用于训练，原 `test` 依据规范化题干哈希约 20% 留给本地评测，其余用于训练。使用本训练集后，完整 CMMLU 官方 test 含本地训练题。
- 对两源统一校验非空题干、四个非空选项和有效答案字母。使用 Unicode NFKC、移除空白及末尾句读后的题干指纹全局去重，优先保留评测条目。同属评测时优先保留 C-Eval，去重共排除 140 条。改写和同源原卷关系未做人工核查。
- 原始目录含公开评测答案及未选入的 CMMLU 题目。训练入口读取 `train.jsonl`，推理入口读取 `evaluation.jsonl`，评分入口再读取答案。两个上游均为公开基准，模型预训练可能已接触。整卷 OCR、图表、主观题和产品发布盲测由项目的原卷评测单独覆盖。

## 来源及许可

- C-Eval（Huang 等，2023），Hugging Face 快照 `617524a00b307ff6f9933702f724131fe12ca7ce`。数据许可 CC BY-NC-SA 4.0。原分片路径与本地文件名对应，路径中的 `/` 在本地替换成 `--`。[发布数据](https://huggingface.co/datasets/ceval/ceval-exam/tree/617524a00b307ff6f9933702f724131fe12ca7ce) · [论文](https://arxiv.org/abs/2305.08322) · [学科映射](https://github.com/hkust-nlp/ceval/blob/main/subject_mapping.json)
- CMMLU（Li 等，2023），Hugging Face 快照 `efcc940752ea4a1ea94d2727f11f83858d64fc8e` 的 `cmmlu_v1_0_1.zip`。官方 GitHub 声明 CC BY-NC-SA 4.0，Hugging Face 数据卡标记 CC BY-NC 4.0。本地按较严格的 CC BY-NC-SA 4.0 记录。[发布数据](https://huggingface.co/datasets/lmlmcat/cmmlu/tree/efcc940752ea4a1ea94d2727f11f83858d64fc8e) · [官方仓库及许可](https://github.com/haonan-li/CMMLU) · [论文](https://arxiv.org/abs/2306.09212)

用已安装 PyArrow 的 Python 运行 `build.py`，可从本地原始文件重建 JSONL 和清单，无需重新下载数据。
