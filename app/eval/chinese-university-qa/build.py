"""Build the local question-answer corpus from the archived upstream files."""

import csv
import hashlib
import io
import json
import re
import unicodedata
import zipfile
from collections import Counter
from pathlib import Path

import pyarrow.parquet as parquet

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "raw"
CHOICES = "ABCD"
CEVAL_PROFESSIONAL = set("""
electrical_engineer metrology_engineer teacher_qualification professional_tour_guide
legal_professional civil_servant urban_and_rural_planner accountant fire_engineer
environmental_impact_assessment_engineer tax_accountant physician
""".split())
CMMLU_SUBJECTS = set("""
agronomy anatomy ancient_chinese arts astronomy business_ethics chinese_literature
clinical_knowledge college_actuarial_science college_education college_engineering_hydrology
college_law college_mathematics college_medical_statistics college_medicine
computer_science computer_security electrical_engineering food_science genetics
international_law journalism jurisprudence machine_learning management marxist_theory
modern_chinese philosophy public_relations sociology sports_science
traditional_chinese_medicine virology
""".split())


def digest(data):
    return hashlib.sha256(data).hexdigest()


def stem_key(stem):
    stem = unicodedata.normalize("NFKC", stem)
    stem = re.sub(r"[\u200b\ufeff\s]", "", stem)
    return digest(stem.rstrip("。？！?!；;").encode())


def record(source, subject, name, split, source_id, row, question, answer):
    stem = row[question].strip()
    options = {letter: (row[letter] or "").strip() for letter in CHOICES}
    label = (row[answer] or "").strip().upper()
    return {
        "id": f"{source}/{subject}/{split}/{source_id}",
        "source": source,
        "source_split": split,
        "subject_id": subject,
        "subject": name,
        "type": "single_choice",
        "question": stem,
        "options": options,
        "answer": label,
        "explanation": (row.get("explanation") or "").strip() or None,
    }


def read_ceval():
    mapping = json.loads((RAW / "ceval-subjects.json").read_text())
    subjects = sorted(
        subject for subject in mapping
        if subject not in CEVAL_PROFESSIONAL
        and not subject.startswith(("high_school_", "middle_school_"))
    )
    for subject in subjects:
        for split in ("dev", "val", "test"):
            path = RAW / "ceval" / f"{subject}--{split}-00000-of-00001.parquet"
            for row in parquet.read_table(path).to_pylist():
                item = record("ceval", subject, mapping[subject][1], split, row["id"],
                              row, "question", "answer")
                yield ("evaluation" if split == "test" else "train"), item


def read_cmmlu():
    mapping = json.loads((RAW / "cmmlu-subjects.json").read_text())
    with zipfile.ZipFile(RAW / "cmmlu.zip") as archive:
        for subject in sorted(CMMLU_SUBJECTS):
            for split in ("dev", "test"):
                with archive.open(f"{split}/{subject}.csv") as data:
                    rows = csv.DictReader(io.TextIOWrapper(data, encoding="utf-8-sig"))
                    for row in rows:
                        item = record("cmmlu", subject, mapping[subject], split, row[""],
                                      row, "Question", "Answer")
                        held_out = split == "test" and int(stem_key(item["question"])[:8], 16) % 5 == 0
                        yield ("evaluation" if held_out else "train"), item


def write_jsonl(name, rows):
    with (ROOT / name).open("w", encoding="utf-8") as output:
        for row in rows:
            output.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def main():
    candidates = list(read_ceval()) + list(read_cmmlu())
    # Preserve evaluation questions and favor C-Eval when both sources contain a stem.
    candidates.sort(key=lambda pair: (pair[0] != "evaluation", pair[1]["source"] != "ceval"))
    counts = Counter()
    excluded = Counter()
    seen = set()
    ids = set()
    train, evaluation, labels = [], [], []
    for split, item in candidates:
        assert item["id"] not in ids, item["id"]
        ids.add(item["id"])
        source = item["source"]
        if (
            not item["question"]
            or not all(item["options"].values())
            or item["answer"] not in item["options"]
        ):
            excluded[(source, split, "missing_text_or_invalid_label")] += 1
            continue
        key = stem_key(item["question"])
        if key in seen:
            excluded[(source, split, "duplicate_stem")] += 1
            continue
        seen.add(key)
        counts[(source, item["subject_id"], item["subject"], split)] += 1
        if split == "train":
            train.append(item)
        else:
            labels.append({"id": item["id"], "answer": item.pop("answer")})
            del item["explanation"]
            evaluation.append(item)

    write_jsonl("train.jsonl", train)
    write_jsonl("evaluation.jsonl", evaluation)
    write_jsonl("evaluation-labels.jsonl", labels)
    files = sorted(path for path in RAW.rglob("*") if path.is_file())
    files += [ROOT / name for name in ("train.jsonl", "evaluation.jsonl", "evaluation-labels.jsonl")]
    manifest = {
        "version": "chinese-university-qa-v1",
        "train": len(train),
        "evaluation": len(evaluation),
        "subjects": [
            {"source": source, "subject_id": subject, "subject": name, "split": split, "count": count}
            for (source, subject, name, split), count in sorted(counts.items())
        ],
        "excluded": [
            {"source": source, "split": split, "reason": reason, "count": count}
            for (source, split, reason), count in sorted(excluded.items())
        ],
        "sha256": {str(path.relative_to(ROOT)): digest(path.read_bytes()) for path in files},
    }
    (ROOT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                                        encoding="utf-8")
    print(f"train={len(train)} evaluation={len(evaluation)} excluded={sum(excluded.values())}")


if __name__ == "__main__":
    main()
