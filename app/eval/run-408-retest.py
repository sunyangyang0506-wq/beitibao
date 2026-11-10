"""Run one local 408 comparison when Beijing's model budget resets."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import time
import unicodedata
from datetime import datetime
from uuid import UUID
from zoneinfo import ZoneInfo

BEIJING = ZoneInfo("Asia/Shanghai")
REFERENCE = Path(__file__).with_name("data") / "408-2014-2023-reference.json"


def query(statement):
    output = subprocess.check_output(
        ["psql", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", statement], text=True
    )
    return json.loads(output)


def page_rows(ids):
    clause = ",".join("'" + str(UUID(item["id"])) + "'" for item in ids)
    return query(f"""
        SELECT coalesce(json_agg(row_to_json(r)), '[]'::json) FROM (
          SELECT p.title, p.status AS paper_status, j.page_number, j.status,
                 j.recognition->'printedPage' AS printed, j.recognition->'stems' AS stems,
                 j.failure
          FROM papers p LEFT JOIN paper_page_recognition j
            ON (j.tenant_id,j.paper_id) = (p.tenant_id,p.id)
          WHERE p.id IN ({clause})
          ORDER BY p.title,j.page_number
        ) r
    """)


def normalized(text):
    return "".join(c for c in unicodedata.normalize("NFKC", text).lower()
                   if c.isalnum())


def measure(rows, reference):
    score = {key: 0 for key in ("failed", "printed_gold", "printed_correct", "page_correct",
                               "expected_stems", "matched_stems", "candidates", "sample_correct")}
    indexed = {(row["title"], row["page_number"]): row for row in rows}
    for year, gold in reference.items():
        for i, (printed, bounds) in enumerate(zip(gold["printed"], gold["ranges"]), 1):
            row = indexed.get((year + "-408", i), {})
            success = row.get("status") == "review"
            score["failed"] += row.get("status") == "failed"
            score["printed_gold"] += printed is not None
            correct = success and row.get("printed") == printed
            score["page_correct"] += correct
            score["printed_correct"] += correct and printed is not None
            expected = set(range(bounds[0], bounds[1] + 1)) if bounds else set()
            score["expected_stems"] += len(expected)
            found = set()
            found_samples = set()
            for stem in row.get("stems") or []:
                score["candidates"] += 1
                match = re.search(r"(?m)^\s*(?:第\s*)?0*(\d{1,2})\s*[.．、)）题]", stem)
                if not match:
                    continue
                number = int(match.group(1))
                if number in expected:
                    found.add(number)
                if number == 1 and 1 in expected and normalized(gold["sample"]) in normalized(stem):
                    score["sample_correct"] += 1 if number not in found_samples else 0
                    found_samples.add(number)
            score["matched_stems"] += len(found)
    return score


def metric(a, b):
    return f"{a}/{b}（{a / b:.1%}）" if b else "—"


def report(path, old, new=None, elapsed=None, reason=None):
    def values(score):
        return [
            str(score["failed"]),
            metric(score["printed_correct"], score["printed_gold"]),
            metric(score["page_correct"], 81),
            metric(score["matched_stems"], score["expected_stems"]),
            metric(score["matched_stems"], score["candidates"]),
            metric(score["sample_correct"], 10),
        ]
    labels = ("失败页", "印刷页码准确率（仅可见页码）", "页码判断准确率（含无印刷页码）",
              "题干定位召回率", "题干定位准确率", "题干开头抽查一致率")
    new_values = values(new) if new else ["待复测"] * len(labels)
    lines = [
        "# 408 真题模型识别对照",
        "",
        "样本为同一批 2014–2023 年 408 真题 PDF，10 套、81 页。旧版数据来自已完成的基线。新版按本机当前设置运行，逐页识别并发为 6。",
        "",
        "| 指标 | 旧版 | 新版 |", "| --- | ---: | ---: |",
        f"| 页码和题干识别耗时 | 214.7 秒 | {f'{elapsed:.1f} 秒' if elapsed is not None else '待复测'} |",
        *[f"| {label} | {before} | {after} |" for label, before, after in zip(labels, values(old), new_values)],
        "",
        "页码参考来自原卷可见印刷标签，未印刷页要求留空。识别失败页计入分母。题干定位以原卷页和大题号同时匹配为正确，重复候选只计一次正确。题干开头抽查每套第 1 题的人工核对片段，忽略标点、空格和全半角差异。这项不覆盖全部题文、选项、图表或答案。",
        "",
    ]
    if reason:
        lines.extend([reason, ""])
    target = path.with_suffix(".tmp")
    target.write_text("\n".join(lines), encoding="utf-8")
    target.replace(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--budget-cents", type=int, default=100)
    parser.add_argument("--baseline-only", action="store_true")
    parser.add_argument("--run-now", action="store_true")
    parser.add_argument("--target-course", type=UUID)
    args = parser.parse_args()
    seed = json.loads(args.seed.read_text())
    reference = json.loads(REFERENCE.read_text())
    old = measure(page_rows(seed["track"]), reference)
    initial_day = datetime.fromisoformat(seed["wallStart"]).astimezone(BEIJING).date()
    report(args.report, old, reason="新版正在等待北京时间的日额度恢复。")
    if args.baseline_only:
        return
    required = min(args.budget_cents * 10_000, 750_000)
    while True:
        day = datetime.now(BEIJING).date()
        used = query(f"""
            SELECT coalesce((SELECT held_micros + spent_micros FROM model_budget_days
              WHERE day = '{day.isoformat()}'), 0)
        """)
        if (args.run_now or day > initial_day) and args.budget_cents * 10_000 - used >= required and required > 0:
            break
        time.sleep(30)

    ids = ",".join("'" + str(UUID(item["id"])) + "'" for item in seed["track"])
    started = datetime.now(BEIJING)
    target = (f"JOIN courses target ON target.id = '{args.target_course}'"
              if args.target_course else "")
    tenant_course = "target.tenant_id,target.id" if args.target_course else "source.tenant_id,source.course_id"
    copies = query(f"""
        WITH copies AS (
          INSERT INTO papers (tenant_id,course_id,title,fingerprint,pdf,media_type,school,recognize_scans,model_allowed)
          SELECT {tenant_course},source.title,source.fingerprint,source.pdf,source.media_type,'408 额度恢复复测 ' || gen_random_uuid(),true,true
          FROM papers source {target} WHERE source.id IN ({ids}) ORDER BY source.created_at
          RETURNING id,tenant_id
        ) SELECT json_agg(copies) FROM copies
    """)
    assert len(copies) == 10
    print("Started 10-paper test", started.isoformat(), flush=True)
    report(args.report, old, reason=f"新版于 {started:%Y-%m-%d %H:%M:%S}（北京时间）启动，正在识别。")
    last_progress = -30
    while (datetime.now(BEIJING) - started).total_seconds() < 900:
        rows = page_rows(copies)
        elapsed = (datetime.now(BEIJING) - started).total_seconds()
        if elapsed - last_progress >= 30:
            completed = sum(row["status"] in ("review", "failed") for row in rows)
            failed = sum(row["status"] == "failed" for row in rows)
            print(f"{elapsed:.0f}s: {completed}/81 settled, {failed} failed", flush=True)
            last_progress = elapsed
        if len(rows) == 81 and all(row["status"] in ("review", "failed") for row in rows):
            model_start = query(f"""
                SELECT to_json(min(created_at)) FROM model_invocations
                WHERE tenant_id='{copies[0]["tenant_id"]}' AND task='page' AND created_at >= '{started.isoformat()}'
            """)
            duration = (datetime.now(BEIJING) - datetime.fromisoformat(model_start)).total_seconds() if model_start else None
            report(args.report, old, measure(rows, reference), duration,
                   reason="新版全部页任务已结束，耗时从首个模型请求计到最后一页进入终态。")
            print("Finished", datetime.now(BEIJING).isoformat(), flush=True)
            return
        if any(row["paper_status"] == "failed" for row in rows):
            report(args.report, old, reason="新版复测有 PDF 解析失败，未完成全批对照。")
            return
        time.sleep(2)
    report(args.report, old, reason="新版复测 15 分钟内未完成，暂不生成完整批次对比。")


if __name__ == "__main__":
    main()
