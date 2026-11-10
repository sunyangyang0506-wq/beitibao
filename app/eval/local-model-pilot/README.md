# 2026-11-10 本地小模型同卷评测

逐题输入、模型原始响应和本机复算材料可按授权从交接包恢复。[材料和恢复说明](../../../docs/handoff/materials.md)

设备为 Apple M4 Mac，16 GB 内存。中文《计算机概要》沿用同一份 4 页题面和 40 道官方单选答案。西语数据结构沿用同一张两列拼版、8 道题、6 张图和教师解答。模型输入来自题面、图或 OCR 输出，评分在本机对照参考答案。[中文卷来源和验收规则](../moex-2020-pilot/README.md) · [西语卷授权与既有复测](../urjc-2025-pilot/README.md)

- PaddleOCR-VL-1.6 使用官方完整权重和 PP-DocLayoutV3。裁片使用 CPU 图表模式，整卷使用 CPU 做版面定位、MLX 做文字识别。中文第 1 页的 CPU 对照另存，不混入整卷成绩。[PaddleOCR Mac 运行方式](https://www.paddleocr.ai/latest/version3.x/pipeline_usage/PaddleOCR-VL-Apple-Silicon.html)
- Qwen3.5-4B 使用 MLX 4-bit 权重，温度 0，关闭 thinking 模式。单选先生成最多 384 Token，对达到上限且尚无明确选项的输出续写一次，追加上限 512 Token。中文题干独立解题与 OCR 输入的整卷解题分开计分。[运行记录](2026-11-10/qwen-runtime-clean.json) · [量化权重](https://huggingface.co/mlx-community/Qwen3.5-4B-4bit)
- HunyuanOCR-1.5 使用 Q4_K_M 文本权重、Q8_0 视觉组件和 llama.cpp b12237，通过相同的结构转录提示读取两张原裁片。使用 CPU 推理。[运行记录](2026-11-10/hunyuan/urjc-figure-1.1.json) · [腾讯运行说明](https://github.com/Tencent-Hunyuan/HunyuanOCR/blob/main/docs/llama_cpp.md)

## 中文卷

| 指标 | 百炼 v20 历史复核 | 本地复测 | 本地严格超过 95% |
| --- | ---: | ---: | :---: |
| 题号和来源页匹配 | 39/40（97.5%） | 40/40（100%） | 是 |
| 印刷页码正确 | 4/4（100%） | 4/4（100%） | 是 |
| 四项齐全 | 39/40（97.5%） | 38/40（95%） | 否 |
| 题干归一化后完全一致 | 35/40（87.5%） | 27/40（67.5%） | 否 |
| 选项归一化后完全一致 | 34/40（85%） | 30/40（75%） | 否 |
| 校对题面的独立解题 | — | 31/40（77.5%） | 否 |
| OCR 到解题的整卷准确率 | 27/40（67.5%） | 29/40（72.5%） | 否 |

独立解题首轮正确 28 道，10 道截断，续写后正确 31 道。整卷首轮正确 25 道，9 道截断，续写后正确 29 道。按明确选项和官方答案计分。

第 11 题 A 项被写成 `(ARAID 0`，第 27 题 A 项开头的数字和选项标记互相干扰。整卷仅将选项齐全的 38 道题交给解题模型，仍按 40 道判分。严格文本一致率只归一化全半角和空白，保留字形、公式和遗漏造成的差异。[逐题评分](2026-11-10/moex-score.json) · [百炼 v20 复核基线](../moex-2020-pilot/official-exam-2020-v20-20261110-audited-score.json)

## 西语卷和图表

PaddleOCR 识出 8/8 道，5,161 个参考字符有 89 次编辑，字符准确率 **98.28%**。版面模型用 1.54 秒找到了 6 个图片区，按框重合度 IoU ≥ 0.5 计为命中时匹配 **5/6**。第 2.1 题的重合度为 0.497。[文字逐题评分](2026-11-10/urjc-text-score.json) · [版面框和重合度](2026-11-10/urjc-layout-score.json)

| 原裁片结构指标 | 百炼 B06 重选后 | PaddleOCR-VL | HunyuanOCR | Qwen3.5-4B |
| --- | ---: | ---: | ---: | ---: |
| 带权图方向和权重同时正确 | 6/6 | 0/6 | 0/6 | 6/6 |
| AVL 节点 | 12/12 | 4/12 | 12/12 | 12/12 |
| AVL 父子关系 | 11/11 | 0/11 | 0/11 | 11/11 |
| AVL 左右位置也正确 | 11/11，含规则补全 | 0/11 | 0/11 | 10/11 |

PaddleOCR 将图转成数据表。混元输出了文字和坐标。Qwen 把 `0036 → 0033` 的左子边写成右子边，实际输出重放进现有 B06 检查后进入人工核对。[图表逐边评分](2026-11-10/figure-score.json) · [人工核对重放](2026-11-10/avl-review-replay.json) · [B06 历史基线](../../../docs/bmad/delivery-verification.md#urjc-同卷识别回归)

西语整卷解题 **3/8（37.5%）**，另有 2 道部分正确和 3 道错误。上次百炼整卷为 5/8。邻接表缺点已答对。AVL 删除后仍保留 `0031` 为根，教师参考为 `0041`。Pascal 好友图重新定义 `StringSet`，集合接口及潜在好友例程仍有错误。代码按教师答案静态审查，第 2.2 题接受 Object Pascal 的隐式解引用。[逐题解题评分](2026-11-10/urjc-solution-score.json) · [Object Pascal 指针语法](https://docwiki.embarcadero.com/RADStudio/Florence/en/Pointers_and_Pointer_Types_%28Delphi%29)

用相同结构转录提示重读自动裁片，Qwen 的带权图仍为 **6/6**，AVL 父子关系仍为 **11/11**，左右位置仍为 **10/11**。自动裁片提供了辨认权重 10 的箭头所需的信息，但在整卷解题的那次输出里，模型仍把它读反，得到 82 而教师参考为 72。图表结构候选须独立核对后再用于解题。[带权图自动裁片](2026-11-10/auto-figure-1.1.png) · [AVL 自动裁片](2026-11-10/auto-figure-1.5.png)

## 费用与复算

本轮本机推理的云模型接口实际费用为 **¥0**。本机电耗未单独计量。百炼中文卷历史基线按接口用量估算为 ¥0.075288，应用从上传到解题结束约 122.2 秒。模型推理时间与历史应用总耗时的测量范围不同。

中文四页识卷合计 **100.0 秒**。整卷 Qwen 解题含续写合计 **468.6 秒**，两段合计约 **9 分 29 秒**。第 1 页 CPU 对照为 137.2 秒，MLX 首次识卷为 59.8 秒。西语整卷识卷 27.3 秒，8 道解题合计 403.1 秒。[CPU 对照](2026-11-10/cpu-comparison/paddle-moex-page-1.json)

从项目根目录运行下面两条命令可用已保存输出复算。`run.py --help` 列出识卷、解题、图表和续写入口，`--runtime` 可指定本机权重目录。

```sh
python3 app/eval/local-model-pilot/score.py score-moex app/eval/local-model-pilot/2026-11-10
python3 app/eval/local-model-pilot/score.py score-figures app/eval/local-model-pilot/2026-11-10
```

运行 `python3 app/eval/local-model-pilot/score.py require-quality app/eval/local-model-pilot/2026-11-10` 可逐项核对所选本地链路。恰好 95% 或缺少评测证据均不通过。此命令复核已见回归样本，放行还需独立授权原卷盲测。

## 严格超过 95% 的复测

同源样本逐项复测，**中文卷的 95% 复测线已通过，项目总体未通过**。分数保持原评分口径。题目漏答和转人工都计入总分母；清晰印刷卷仍按架构中的更高上线要求验收。

| 指标 | 本地原流程 | 本地改进后 |
| --- | ---: | ---: |
| 中文卷题号及原页、印刷页码 | 40/40、4/4 | 40/40、4/4 |
| 中文卷四项齐全 | 38/40（95%） | 39/40（97.5%） |
| 中文卷题干逐字一致 | 27/40（67.5%） | 39/40（97.5%） |
| 中文卷四个选项逐字一致 | 30/40（75%） | 39/40（97.5%） |
| 中文卷正确题面解题 | 31/40（77.5%） | 40/40（100%） |
| 中文卷原页到答案 | 29/40（72.5%） | 39/40（97.5%） |
| 西语卷字符准确率 | 98.28% | 98.28% |
| 西语卷图表定位（IoU ≥ 0.5） | 5/6（83.33%） | 5/6（83.33%） |
| 带权图方向与权重 | 6/6 | 6/6 |
| AVL 父子边及左右位 | 10/11（90.91%） | 11/11（100%，含规则校验） |
| 西语卷逐大题解题 | 3/8（37.5%） | 5/8（62.5%） |

中文卷的第二次识别只处理同一原页的像素，逐页校验输入哈希。Vision 提供独立字形和定位证据；对有印刷证据的残缺标签、同一选项的重复识别、进制和上下标做有限修复。第 27 题的 A 标签与数字在原图上重叠，保留人工核对。四页 Vision 推理合计约 11 秒。保持原解题提示和续写机制时，新题面把端到端分数提高到 31/40。其上叠加适用题型的精确计算和公开资料核验，才得到表中的 39/40。答案不参与修复或选路。仅将输入一致的模型响应复用到新对比；15 道题面变化的题实际重跑。短答实验仅答对 24/40，未采用。

图表方面，原始和自动 AVL 裁片分别读取 12 个节点、12 个高度和 11 条父子关系，确认一致后按搜索树约束计算左右位。应用增加了同样的核对条件：两次读数若明确冲突，仍交人工。带权图和 AVL 的结构化求解分别核对教师解答第 644 和 646 页，出度为 72，AVL 删除后根为 0041，最终 10 条左右子边均一致。其余解答沿用已有实测；本轮额外试过 Pascal 提示词，仍有递归指针、遍历顺序、奇数节点子树求和及外部单元错误，未替换原流程。图表定位仍按原框重合度判定。

预测卷另审了已保存的 6 道合成题：引用来源范围、可解性和答案分别为 6/6，引用实际支撑推演为 5/6。第 1 题引用只给出遍历类别，未支持队列操作的变形依据。独立考前证据集和考后真题命中率尚未验收。

本轮新增识别、解题和验算在本机执行，云模型推理费用为 **¥0**。北京通用端点探测返回 `Arrearage`，评测空间端点返回 `AccessDenied.Unpurchased`，均未返回用量；没有可评分的新百炼结果。独立发布盲测须覆盖清晰图像、复杂公式与图表、客观题和 Pascal 等主观题；预测按架构要求至少 30 套证据集。新 OCR 和解题组合在本地评测中验证，尚未替换线上模型。

核对资料：[OMG UML](https://www.omg.org/UML/what-is-uml.htm) · [《操作系统概念》配套指南](https://codex.cs.yale.edu/avi/os-book/OS10/study-guide/Study-Guide.pdf) · [Linux 伙伴系统页块说明](https://www.kernel.org/doc/html/latest/admin-guide/mm/pagemap.html)；事实复核的每条资料链接随相应模型响应保存。

[中文逐题结果](2026-11-10-quality/moex-checked-score.json) · [图表与计算](2026-11-10-quality/urjc-structured-solutions.json) · [西语逐题结果](2026-11-10-quality/urjc-solution-score.json) · [预测复核](2026-11-10-quality/prediction-audit.json) · [逐项验收门](2026-11-10-quality/quality-gate.json)

```sh
pilot=app/eval/local-model-pilot
run="$pilot/2026-11-10-quality"
python3 "$pilot/check_rules.py"
python3 "$pilot/score.py" score-moex-checked "$run"
python3 "$pilot/structured_solve.py" "$pilot/2026-11-10" "$run"
python3 "$pilot/review_urjc.py" "$pilot/2026-11-10" "$run"
python3 "$pilot/score.py" require-quality "$run"
python3 "$pilot/review_prediction.py" app/eval/prediction-data-structures-v21-workflow-20261109.json "$run/prediction-audit.json"
```

两个验收命令应返回非零状态。Mac 上可另用 `python3 "$pilot/moex_reread.py" "$pilot/2026-11-10" <新结果目录>` 从原始 PDF 重跑 Vision 合并，不改写原始记录。规则校验另通过了 323 个合成选择题、反向边冲突和 AVL 双旋测试。
