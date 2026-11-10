"""Prepare local solver inputs and compare predictions to the existing exam references."""

import argparse
from collections import Counter
from html import unescape
import json
from pathlib import Path
import re
import unicodedata

from run import MOEX, SCRATCH, URJC, choice_text, clean_moex_cases, read_json, save_json


QUESTION = re.compile(r"(?m)^[ \t]*(\d{1,2})(?:[.、)．][ \t]*|[ \t]+|[ \t]*\n[ \t]*)(?=\S)")
OPTION = re.compile(r"[（(]\s*([A-DＡ-Ｄ])\s*[)）]|(?<![A-Za-z0-9_])([A-DＡ-Ｄ])[.、)）:：．]", re.U)
PRINTED_PAGE = re.compile(r"[頁页]次\s*[:：]?\s*(\d+)\s*[-–—－]\s*(\d+)")
EXERCISE = re.compile(r"(?im)^[ \t]*Ejercicio\s+([12]\.[1-5])\b")
ATTRIBUTION = re.compile(r"(?im)^\s*(?:URJC\s*·|Sergio Cavero Díaz).*$")
GRAPH_NODES = list("ABCDE")
GRAPH_EDGES = [("B", "A", 10), ("A", "C", 12), ("C", "B", 20), ("A", "D", 60), ("E", "A", 7), ("C", "D", 32)]
AVL_NODES = [("0031", 5), ("0016", 3), ("0041", 4), ("0008", 2), ("0021", 1), ("0036", 2),
             ("0051", 3), ("0010", 1), ("0033", 1), ("0044", 2), ("0053", 1), ("0048", 1)]
AVL_EDGES = [("0031", "0016", "L"), ("0031", "0041", "R"), ("0016", "0008", "L"), ("0016", "0021", "R"),
             ("0008", "0010", "R"), ("0041", "0036", "L"), ("0041", "0051", "R"), ("0036", "0033", "L"),
             ("0051", "0044", "L"), ("0051", "0053", "R"), ("0044", "0048", "R")]


def plain(markdown):
    text = re.sub(r"!\[[^\]]*\]\([^\n]*\)", "", markdown)
    text = re.sub(r"<br\s*/?>|</(?:div|p)>", "\n", text, flags=re.I)
    text = re.sub(r"</?(?:div|p|span|b|strong|img|pre|code|center)\b[^>]*>", "", text, flags=re.I)
    text = re.sub(r"(?m)^[ \t]*(?:#+[ \t]+|```[^\n]*$)", "", text)
    text = re.sub(r"\*\*([^*\n]+)\*\*", r"\1", text)
    return unescape(text).replace("\u00a0", " ")


def key(text):
    return re.sub(r"[\s\u200b-\u200d]+", "", unicodedata.normalize("NFKC", text))


def split_options(text):
    markers = []
    for match in OPTION.finditer(text):
        letter = unicodedata.normalize("NFKC", match[1] or match[2])
        if letter == "ABCD"[len(markers)]:
            markers.append(match)
            if len(markers) == 4:
                break
    if not markers:
        return text.strip(), {}
    options = {}
    for index, match in enumerate(markers):
        end = markers[index + 1].start() if index + 1 < len(markers) else len(text)
        options["ABCD"[index]] = text[match.end():end].strip()
    return text[:markers[0].start()].strip(), options


def prepare_moex(output):
    source_pages = []
    cases = []
    for page in range(1, 5):
        path = output / f"paddle-moex-page-{page}.json"
        data = read_json(path)
        text = plain(data["markdown"])
        matches = list(QUESTION.finditer(text))
        printed = PRINTED_PAGE.search(text)
        candidates = []
        for index, match in enumerate(matches):
            end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
            number = int(match[1])
            stem, options = split_options(text[match.end():end])
            if not stem:
                continue
            candidates.append({"number": number, "stem": stem, "options": options})
        for item in candidates:
            number = item["number"]
            if sum(row["number"] == number for row in candidates) == 1 and len(item["options"]) == 4 and all(item["options"].values()):
                cases.append({"id": f"moex-e2e-p{page}-{number:02}", "kind": "choice", "text": choice_text(item["stem"], item["options"])})
        source_pages.append({"page": page, "printedPage": int(printed[2]) if printed else None,
                             "seconds": data["seconds"], "candidates": candidates})
    save_json(output / "moex-ocr-parsed.json", source_pages)
    save_json(output / "moex-e2e-inputs.json", cases)
    print("MOEX candidates per page:", [[q["number"] for q in p["candidates"]] for p in source_pages])


def prepare_urjc(output):
    from PIL import Image

    SCRATCH.mkdir(parents=True, exist_ok=True)
    data = read_json(output / "paddle-whole-paper.json")
    pages = data["result"]["parsing_res_list"]
    candidates = []
    image_blocks = {"image", "figure", "chart", "diagram"}
    with Image.open(URJC / "whole-paper.png") as source:
        current = None
        # The existing evaluation fixture is a two-column montage. Read down each column.
        def reading_order(block):
            x, y, _, _ = block["block_bbox"]
            return x >= source.width / 2, y, x

        for block in sorted(pages, key=reading_order):
            bbox = [int(i) for i in block["block_bbox"]]
            label = block["block_label"]
            if label in image_blocks:
                if current and bbox[2] > bbox[0] and bbox[3] > bbox[1]:
                    path = SCRATCH / f"urjc-auto-{current['number']}-{len(current['images'])}.png"
                    source.crop(bbox).save(path)
                    current["images"].append(str(path))
                    current["figureBoxes"].append(bbox)
                continue
            text = ATTRIBUTION.sub("", plain(block["block_content"])).strip()
            if not text:
                continue
            matches = list(EXERCISE.finditer(text))
            if matches:
                if current and matches[0].start():
                    current["textParts"].append(text[:matches[0].start()].strip())
                for index, match in enumerate(matches):
                    end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
                    current = {"number": match[1], "textParts": [text[match.start():end].strip()],
                               "images": [], "figureBoxes": []}
                    candidates.append(current)
            elif current:
                current["textParts"].append(text)

    cases = []
    for item in candidates:
        number = item["number"]
        if sum(q["number"] == number for q in candidates) == 1:
            cases.append({"id": f"urjc-e2e-{number}", "kind": "urjc", "text": "\n".join(item["textParts"]),
                          "images": item["images"]})
    save_json(output / "urjc-ocr-parsed.json", candidates)
    save_json(output / "urjc-e2e-inputs.json", cases)
    print("URJC questions and figure candidates:", [(q["number"], len(q["images"])) for q in candidates])


def get_answer(output, name):
    path = output / "qwen" / (name + ".json")
    if not path.exists():
        return None
    row = read_json(path)
    retry_path = output / "qwen-retry" / path.name
    if retry_path.exists():
        retry = read_json(retry_path)
        assert row["answer"] is None and row["generatedTokens"] >= row["tokenLimit"]
        assert retry["input"] == row["input"]
        return {**retry, "seconds": row["seconds"] + retry["seconds"], "retried": True}
    return row


def score_moex(output, checked=False):
    gold = read_json(MOEX / "official-exam-2020-gold.json")
    clean_inputs = {case["id"]: case["text"] for case in clean_moex_cases()}
    pages = {p["page"]: p for p in read_json(output / "moex-ocr-parsed.json")} if (output / "moex-ocr-parsed.json").exists() else {}
    if checked:
        from choice_verify import verify
        from concept_sources import sources_for

        def source_check(row, text, exact):
            if not row or exact:
                return None
            path = output / "qwen-source" / f"{row['id']}.json"
            if not path.exists():
                return None
            result = read_json(path)
            if (result["input"] != text or result["sources"] != sources_for(text)
                    or result.get("promptVersion") != "source-choice-v3"):
                raise ValueError(f"Source review for {row['id']} does not match its input")
            return result

    rows = []
    for ref in gold["questions"]:
        page, number = ref["page"], ref["number"]
        candidates = [q for q in pages.get(page, {}).get("candidates", []) if q["number"] == number]
        ocr = candidates[0] if len(candidates) == 1 else None
        clean = get_answer(output, f"moex-clean-{number:02}")
        e2e = get_answer(output, f"moex-e2e-p{page}-{number:02}")
        clean_input = clean_inputs[f"moex-clean-{number:02}"]
        e2e_input = choice_text(ocr["stem"], ocr["options"]) if ocr else None
        if (clean and clean["input"] != clean_input) or (e2e and e2e["input"] != e2e_input):
            raise ValueError(f"Solver record for question {number} does not match its input")
        clean_answer = clean["answer"] if clean else None
        e2e_answer = e2e["answer"] if e2e else None
        verification = {}
        if checked:
            # Reconstruct the exact solver input. The reference answer stays in the scorer.
            clean_check = verify(clean_input)
            e2e_check = verify(e2e_input) if e2e_input else None
            clean_source = source_check(clean, clean_input, clean_check)
            e2e_source = source_check(e2e, e2e_input, e2e_check)
            verification = {"cleanModelAnswer": clean_answer, "e2eModelAnswer": e2e_answer,
                            "cleanVerification": clean_check, "e2eVerification": e2e_check,
                            "cleanSourceAnswer": clean_source["answer"] if clean_source else None,
                            "e2eSourceAnswer": e2e_source["answer"] if e2e_source else None}
            clean_answer = clean_check["answer"] if clean_check else clean_answer
            e2e_answer = e2e_check["answer"] if e2e_check else e2e_answer
            if clean_source and clean_source["answer"] in ("A", "B", "C", "D"):
                clean_answer = clean_source["answer"]
            if e2e_source and e2e_source["answer"] in ("A", "B", "C", "D"):
                e2e_answer = e2e_source["answer"]
        rows.append({"page": page, "number": number, "referenceAnswer": ref["answer"],
                     "detected": ocr is not None,
                     "fourOptions": bool(ocr and len(ocr["options"]) == 4 and all(ocr["options"].values())),
                     "exactStem": bool(ocr and key(ocr["stem"]) == key(ref["stem"])),
                     "exactOptions": bool(ocr and all(key(ocr["options"].get(k, "")) == key(v) for k, v in ref["options"].items())),
                     "cleanAnswer": clean_answer, "cleanCorrect": clean_answer == ref["answer"],
                     "e2eAnswer": e2e_answer, "e2eCorrect": e2e_answer == ref["answer"],
                     "cleanSeconds": clean["seconds"] if clean else None, "e2eSeconds": e2e["seconds"] if e2e else None,
                     "cleanRetried": bool(clean and clean.get("retried")), "e2eRetried": bool(e2e and e2e.get("retried")),
                     **verification})
    counts = {field: sum(row[field] for row in rows) for field in
              ("detected", "fourOptions", "exactStem", "exactOptions", "cleanCorrect", "e2eCorrect")}
    counts.update(total=len(rows), printedPages=sum(p["printedPage"] == p["page"] for p in pages.values()),
                  sourcePages=gold["sourcePages"], cleanRuns=sum(r["cleanSeconds"] is not None for r in rows),
                  e2eRuns=sum(r["e2eSeconds"] is not None for r in rows))
    score_file = "moex-checked-score.json" if checked else "moex-score.json"
    save_json(output / score_file, {"referenceRevision": gold["referenceRevision"], "counts": counts, "rows": rows})
    print(json.dumps(counts))


def edit_distance(reference, observed):
    previous = list(range(len(observed) + 1))
    for i, expected in enumerate(reference, 1):
        current = [i]
        for j, actual in enumerate(observed, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (expected != actual)))
        previous = current
    return previous[-1]


def score_urjc_text(output):
    refs = read_json(URJC / "question-text.json")
    candidates = read_json(output / "urjc-ocr-parsed.json")
    punctuation = str.maketrans({'“': '"', '”': '"', '–': '-', '—': '-'})
    rows = []
    for number, parts in refs.items():
        matches = [q for q in candidates if q["number"] == number]
        found = matches[0] if len(matches) == 1 else None
        reference = key("\n".join(part for part in parts if not part.startswith("@")).translate(punctuation))
        observed = key("\n".join(found["textParts"]).translate(punctuation)) if found else ""
        rows.append({"number": number, "detected": found is not None, "referenceCharacters": len(reference),
                     "edits": edit_distance(reference, observed), "detectedFigureBoxes": len(found["images"]) if found else 0})
    total = sum(row["referenceCharacters"] for row in rows)
    errors = sum(row["edits"] for row in rows)
    counts = {"detected": sum(row["detected"] for row in rows), "total": len(rows), "referenceCharacters": total,
              "edits": errors, "characterAccuracy": (total - errors) / total}
    save_json(output / "urjc-text-score.json", {"counts": counts, "rows": rows})
    print(json.dumps(counts))


def structured(raw):
    decoder = json.JSONDecoder()
    for start in re.finditer(r"\[\s*(?=\{)|\{", raw):
        try:
            item, _ = decoder.raw_decode(raw[start.start():])
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict) and isinstance(item.get("edges"), list):
            return item
        if isinstance(item, list) and item and all(isinstance(edge, dict) and
                isinstance(edge.get("source"), str) and isinstance(edge.get("target"), str) and
                isinstance(edge.get("weight"), (int, str)) for edge in item):
            edges = [[edge["source"], edge["target"], edge["weight"]] for edge in item]
            return {"edges": edges, "nodes": sorted({node for edge in edges for node in edge[:2]}), "edgeList": True}
    return {}


def spotted_text(raw):
    decoder = json.JSONDecoder()
    for start in re.finditer(r"\[\s*\{", raw):
        try:
            items, _ = decoder.raw_decode(raw[start.start():])
        except json.JSONDecodeError:
            continue
        if isinstance(items, list) and all(isinstance(item, dict) and isinstance(item.get("text"), str) for item in items):
            return [item["text"].strip() for item in items]
    return []


def counts(expected, observed):
    left, right = Counter(expected), Counter(observed)
    return {"matched": sum((left & right).values()), "total": len(expected),
            "missing": list((left - right).elements()), "extra": list((right - left).elements())}


def pairs(items, width):
    if not isinstance(items, list):
        return []
    return [tuple(row) for row in items if isinstance(row, list) and len(row) == width and
            all(isinstance(value, (str, int)) for value in row)]


def figure_score(raw, number):
    item = structured(raw)
    edges = pairs(item.get("edges"), 3)
    if number == "1.1":
        raw_nodes = item.get("nodes")
        nodes = [v for v in raw_nodes if isinstance(v, str)] if isinstance(raw_nodes, list) else []
        edges = [(a, b, int(w) if str(w).isdigit() else w) for a, b, w in edges]
        return {"structured": bool(item), "edgeList": bool(item.get("edgeList")),
                "nodes": counts(GRAPH_NODES, nodes), "edges": counts(GRAPH_EDGES, edges)}
    nodes = pairs(item.get("nodes"), 2)
    parents = [edge[:2] for edge in edges] + pairs(item.get("edges"), 2)
    return {"structured": bool(item), "root": item.get("root"),
            "nodes": counts([n for n, _ in AVL_NODES], [n for n, _ in nodes]),
            "heights": counts(AVL_NODES, nodes), "parentChild": counts([edge[:2] for edge in AVL_EDGES], parents),
            "edgesWithSide": counts(AVL_EDGES, edges)}


def score_figures(output):
    scores = {}
    for number in ("1.1", "1.5"):
        scores[number] = {}
        for engine in ("paddle", "qwen", "qwen-auto", "hunyuan"):
            path = output / engine / f"urjc-figure-{number}.json"
            if engine == "paddle":
                path = output / f"paddle-b06-figure-{number}.json"
            elif engine == "qwen-auto":
                path = output / "qwen" / f"urjc-auto-figure-{number}.json"
            if path.exists():
                row = read_json(path)
                if row.get("returnCode", 0) != 0:
                    continue
                raw = row.get("raw") or row.get("markdown") or ""
                result = figure_score(raw, number)
                if engine == "paddle" and not result["structured"]:
                    # The chart task can return a table with labels while omitting the edges.
                    chart_text = "\n".join(block["block_content"] for block in row["result"]["parsing_res_list"]
                                           if block["block_label"] == "chart")
                    cells = re.findall(r"(?m)^([A-Z]|\d+)\s*\|\s*(\d+)\s*$", chart_text)
                    result["tableRows"] = cells
                    names = GRAPH_NODES if number == "1.1" else [name for name, _ in AVL_NODES]
                    result["nodes"] = counts(names, [name for name, _ in cells])
                    if number == "1.5":
                        result["heights"] = counts(AVL_NODES, [(name, int(height)) for name, height in cells])
                if engine == "hunyuan" and not result["structured"]:
                    labels = spotted_text(raw)
                    result["spottingText"] = labels
                    if number == "1.1":
                        result["nodes"] = counts(GRAPH_NODES, [label for label in labels if re.fullmatch(r"[A-Z]", label)])
                    else:
                        result["nodes"] = counts([name for name, _ in AVL_NODES],
                                                 [label for label in labels if re.fullmatch(r"\d{4}", label)])
                scores[number][engine] = result
    save_json(output / "figure-score.json", scores)
    print(json.dumps(scores, ensure_ascii=False))


def require_quality(output):
    minimum = 95
    checks = []

    def check(name, correct, total, extras=0):
        checks.append({"metric": name, "correct": correct, "total": total, "extra": extras,
                       "passed": total > 0 and 0 <= correct <= total and 100 * correct > minimum * total and extras == 0})

    checked = (output / "moex-checked-score.json").exists()
    moex = read_json(output / ("moex-checked-score.json" if checked else "moex-score.json"))["counts"]
    for name in ("detected", "fourOptions", "exactStem", "exactOptions", "cleanCorrect", "e2eCorrect"):
        check(f"moex.{name}", moex[name], moex["total"])
    check("moex.printedPages", moex["printedPages"], moex["sourcePages"])

    urjc_text = read_json(output / "urjc-text-score.json")["counts"]
    urjc_layout = read_json(output / "urjc-layout-score.json")
    urjc_solutions = read_json(output / "urjc-solution-score.json")
    check("urjc.detected", urjc_text["detected"], urjc_text["total"])
    check("urjc.characters", max(0, urjc_text["referenceCharacters"] - urjc_text["edits"]), urjc_text["referenceCharacters"])
    check("urjc.figureLocations", urjc_layout["matched"], urjc_layout["total"])
    check("urjc.solved", urjc_solutions["correct"], urjc_solutions["total"])

    structured_path = output / "urjc-structured-solutions.json"
    if structured_path.exists():
        figures = read_json(structured_path)["figure"]
        for index, crop in enumerate(("originalCrop", "automaticCrop")):
            for metric in ("nodes", "edges"):
                result = figures["directed"][index][metric]
                check(f"urjc.{crop}.directed.{metric}", result["matched"], result["total"], len(result["extra"]))
            for metric in ("nodes", "heights", "parentChild"):
                result = figures["avlParentsOnly"][index][metric]
                check(f"urjc.{crop}.avl.{metric}", result["matched"], result["total"], len(result["extra"]))
        result = figures["avlVerified"]["edgesWithSide"]
        check("urjc.avl.verifiedSides", result["matched"], result["total"], len(result["extra"]))
    else:
        figures = read_json(output / "figure-score.json")
        for engine in ("qwen", "qwen-auto"):
            for question, metrics in (("1.1", ("nodes", "edges")), ("1.5", ("nodes", "heights", "parentChild", "edgesWithSide"))):
                for metric in metrics:
                    result = figures[question].get(engine, {}).get(metric, {"matched": 0, "total": 0, "extra": []})
                    check(f"urjc.{engine}.{question}.{metric}", result["matched"], result["total"], len(result["extra"]))

    measured = (moex["cleanRuns"] == moex["total"] and moex["e2eRuns"] == moex["fourOptions"] and
                moex["sourcePages"] == 4 and urjc_solutions["total"] == 8)
    passed = measured and all(row["passed"] for row in checks)
    print(json.dumps({"minimumPercent": minimum, "comparison": ">", "scope": "same-paper-regression", "measured": measured, "checkedChoiceRules": checked,
                      "passed": passed, "checks": checks}, ensure_ascii=False))
    if not passed:
        raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = {"prepare-moex": prepare_moex, "prepare-urjc": prepare_urjc,
               "score-moex": score_moex, "score-moex-checked": lambda output: score_moex(output, checked=True),
               "score-figures": score_figures, "score-urjc-text": score_urjc_text,
               "require-quality": require_quality}
    parser.add_argument("mode", choices=actions)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    actions[args.mode](args.output)


if __name__ == "__main__":
    main()
