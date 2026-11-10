"""Score a human prediction audit bound to a frozen generation result."""

import argparse
import json
from pathlib import Path

from run import read_json, sha256


def review(result_path, audit_path):
    result, audit = read_json(result_path), read_json(audit_path)
    if audit["sampleKind"] != "synthetic-development":
        raise ValueError("This scorer only grades the synthetic workflow audit")
    if audit["resultSha256"] != sha256(result_path):
        raise ValueError("The audit is not for this prediction result")
    rows, generated = audit["rows"], result["questions"]
    if [r["number"] for r in rows] != list(range(1, len(generated) + 1)):
        raise ValueError("Audit must include every generated question exactly once")
    total = len(generated)
    metrics = {}
    for key in ("evidenceSupports", "solvable", "answerCorrect"):
        if any(type(row[key]) is not bool or not row.get("note") for row in rows):
            raise ValueError(f"Invalid audit for {key}")
        n = sum(row[key] for row in rows)
        metrics[key] = {"correct": n, "total": total, "passed": total > 0 and 100 * n > 95 * total}
    source_count = sum(bool(question.get("sourceStems")) for question in generated) if result.get("verified", {}).get("evidenceBelongsToCourse") is True else 0
    metrics["citationsInSourceSet"] = {"correct": source_count, "total": total, "passed": total > 0 and source_count == total}
    return {
        "scope": "historical-synthetic",
        "minimumPercent": 95,
        "comparison": ">",
        "metrics": metrics,
        "allMeasuredMetricsPassed": all(metric["passed"] for metric in metrics.values()),
        "independentEvidenceSets": 0,
        "minimumIndependentEvidenceSets": 30,
        "realExamHitRate": None,
        "releasePassed": False,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("result", type=Path)
    parser.add_argument("audit", type=Path)
    args = parser.parse_args()
    report = review(args.result, args.audit)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if not report["releasePassed"]:
        raise SystemExit(1)
