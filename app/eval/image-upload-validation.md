# 用户图片上传校验

2026-11-08，使用生产上传接口和后台任务逻辑，在隔离数据库中校验。以单张页图为一次上传，用户可在原图旁核对题目，然后开始练习。

## 网页操作

Playwright 实际使用连接本地 API 的网页文件选择器。桌面窗口上传 JPG，390 × 844 窄屏窗口上传 PNG。两种格式均勾选授权、提交文件、看到原图与待核对题干、确认题目、开始练习并提交。桌面另验证保存草稿。网页测试使用合成题面和固定识别输出。窄屏使用浏览器视口模拟。当前入口每次选一个文件，逐页回归按每张图片分别归档。

## 新版真题逐页回归

26 份本地真题共 100 页，每页上传一次，三种图片形态轮流分配。此批材料只在本机由 macOS Vision 读取，未调用百炼。

| 输入形态 | 上传成功 | 有 OCR 文本 |
| --- | ---: | ---: |
| PNG 页图 | 34/34 | 34/34 |
| JPG 模拟拍照，倾斜 3°、降低亮度并压缩 | 33/33 | 33/33 |
| JPG 使用 EXIF 方向标签 | 33/33 | 33/33 |

100 张原图预览的字节与上传文件一致，重复上传复用原记录，其他账号无法打开原图，确认前无法开始原卷练习。此批没有逐字、题目边界、公式和图表金标，因此只能计算上传和 OCR 出文率。

[逐页结果](image-upload-local-results.json)记录输入形态、OCR 字符数和耗时。在 `app/` 运行 `bash scripts/test-local.sh --image-upload` 可重跑。

## 百炼图题配对

北京「评测」工作空间使用 `qwen3.5-flash-2026-02-23`。以 [URJC 授权、脱敏题面](urjc-2025-pilot/README.md)中两道题为图样。清晰 PNG 和模拟拍照 JPG 来自同一张题面。JPG 增加 3° 倾斜，亮度乘以 0.92，JPEG 质量设为 68。输入只有题面。文字以规范化后的字符编辑距离计分，图表对照原图的节点、方向和权重。

| 图题 | 清晰 PNG | 模拟拍照 JPG |
| --- | --- | --- |
| 1.1 带权有向图 | 249/249 字。初读图正确，裁片漏掉 E→A（权重 7），自动转人工。 | 249/249 字。初读和裁片均读对 5 个节点、6 条边的方向及权重。 |
| 1.5 AVL 树 | 192/192 字。图表未得到可用结构，自动转人工。 | 两次独立上传均未产出可核对题干。第一次百炼返回 JSON 生成中断，第二次 HTTP 200 但应用未得到有效识别结果。 |

按首次上传计，模拟拍照 JPG 检出 1/2 题，完整识别 1/2 张图。把漏题计入字符分母，JPG 为 249/441（56.46%），清晰 PNG 为 441/441（100%）。样本只有两道西语图题，不能估计中文真题手机实拍的识别准确率。另有一轮八题拼接长图 JPG 请求超时，未产出可评分结果。

成功请求的 Token 按项目费率计，带权图 PNG ¥0.0014386，带权图 JPG ¥0.0015672，AVL PNG ¥0.0023602，AVL JPG 复测的 HTTP 200 请求 ¥0.0002840。失败请求的实际扣费待账单核对。

应用对百炼明确报出的 JSON 生成中断至多重试一次，两次调用共用原超时窗口。自动测试覆盖恢复和重试后仍失败的情况。AVL JPG 的 HTTP 200 复测仍失败，记录保留。

- 带权图原始结果 [PNG](urjc-2025-pilot/results-phone-page-png.json) · [JPG](urjc-2025-pilot/results-phone-page-jpeg.json)
- AVL 原始结果 [PNG](urjc-2025-pilot/results-phone-avl-png.json) · [JPG 首测](urjc-2025-pilot/results-phone-avl-jpeg.json) · [JPG 复测](urjc-2025-pilot/results-phone-avl-jpeg-recheck.json)
- [拼接长图超时记录](urjc-2025-pilot/results-phone-jpeg.json)

从 `app/` 运行 `bash scripts/test-local.sh --urjc-whole-paper --figures-only --question=1.1 --phone-jpeg --report=results-phone-repeat.json` 可复测并产生百炼调用。在项目根目录用 `python3 app/eval/urjc-2025-pilot/score-whole-paper.py results-phone-repeat.json` 可复算。
