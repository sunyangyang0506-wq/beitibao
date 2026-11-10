"""Grade the two structured answers against the instructor reference (pp. 644, 646)."""

import argparse
from pathlib import Path

from run import read_json, save_json


def review(previous, output):
    report = read_json(previous / "urjc-solution-score.json")
    observed = read_json(output / "urjc-structured-solutions.json")
    graph = observed["graph"]
    graph_correct = ("".join(graph["BFS"]) in {"ACDB", "ADCB"}
                     and "".join(graph["DFS"]) in {"EACBD", "EADCB", "EACDB"}
                     and graph["weightedOutDegree"] == 72)
    # Independently transcribed from the final green tree on instructor page 646.
    tree = observed["avl"]
    nodes = {("0041", 4), ("0031", 3), ("0051", 3), ("0010", 2), ("0036", 2), ("0044", 2),
             ("0008", 1), ("0016", 1), ("0033", 1), ("0048", 1), ("0053", 1)}
    edges = {("0041", "0031", "L"), ("0041", "0051", "R"), ("0031", "0010", "L"),
             ("0031", "0036", "R"), ("0010", "0008", "L"), ("0010", "0016", "R"),
             ("0036", "0033", "L"), ("0051", "0044", "L"), ("0051", "0053", "R"), ("0044", "0048", "R")}
    tree_correct = (tree["root"] == "0041" and len(tree["nodes"]) == len(nodes) and len(tree["edges"]) == len(edges)
                    and {tuple(n) for n in tree["nodes"]} == nodes and {tuple(e) for e in tree["edges"]} == edges)
    for row in report["rows"]:
        if row["number"] not in ("1.1", "1.5"):
            row["prediction"] = "../2026-11-10/" + row["prediction"]
            continue
        is_graph = row["number"] == "1.1"
        correct = graph_correct if is_graph else tree_correct
        row.update(
            status="correct" if correct else "wrong",
            note=("BFS、DFS 和加权出度均与教师答案一致。" if is_graph else
                  "删除后根、11 个节点高度和 10 条左右子边均与教师图一致。") if correct else "至少一项与教师解答不符。",
            prediction="urjc-structured-solutions.json",
            seconds=None,
            truncated=False,
        )
    # This is a mixed replay with fresh crop readings, so there is no new whole-paper latency.
    report.pop("seconds", None)
    report["solutionRoute"] = "structured-graph-and-avl; other answers replayed"
    for status in ("correct", "partial", "wrong"):
        report[status] = sum(row["status"] == status for row in report["rows"])
    save_json(output / "urjc-solution-score.json", report)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("previous", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    review(args.previous, args.output)
