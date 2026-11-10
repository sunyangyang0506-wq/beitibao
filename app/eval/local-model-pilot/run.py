"""Run local models on the existing MOEX and URJC fixtures and retain raw outputs."""

import argparse
import hashlib
from importlib.metadata import version
import json
import os
from pathlib import Path
import re
import subprocess
import time


EVAL = Path(__file__).resolve().parent.parent
ROOT = EVAL.parent.parent
MOEX = EVAL / "moex-2020-pilot"
URJC = EVAL / "urjc-2025-pilot"
SCRATCH = ROOT / "tmp/pdfs/local-model-pilot"
RUNTIME = Path.home() / ".cache/beitibao/local-model-pilot"


def read_json(path):
    return json.loads(path.read_text())


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_suffix(".tmp")
    pending.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    pending.replace(path)


def sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def render_moex():
    pdf = MOEX / "trial-question-pages.pdf"
    assert sha256(pdf) == "497b779fd1596cf3d8151b338b5c2623c01504963d1b06ad61401f5397744882"
    SCRATCH.mkdir(parents=True, exist_ok=True)
    subprocess.run(["pdftoppm", "-scale-to", "2400", "-png", str(pdf), str(SCRATCH / "moex-page")], check=True)
    return [SCRATCH / f"moex-page-{page}.png" for page in range(1, 5)]


def run_ocr(runtime, output):
    from paddleocr import PaddleOCRVL

    pages = render_moex()
    inputs = [URJC / "b06-figure-1.1.png", URJC / "b06-figure-1.5.png", *pages, URJC / "whole-paper.png"]
    model_dir = runtime / "paddle-vl"
    layout_dir = runtime / "layout"
    settings = dict(
        pipeline_version="v1.6",
        device="cpu",
        layout_detection_model_dir=str(layout_dir),
        vl_rec_model_dir=str(model_dir),
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_chart_recognition=True,
        markdown_ignore_labels=[],
    )
    server = os.getenv("BEITIBAO_OCR_MLX_SERVER")
    if server:
        settings.update(vl_rec_backend="mlx-vlm-server", vl_rec_server_url=server,
                        vl_rec_api_model_name=str(model_dir))
    backend = "paddle-cpu+mlx" if server else "paddle-cpu"
    started = time.perf_counter()
    model = PaddleOCRVL(**settings)
    runtime_report = "paddle-runtime-mlx.json" if server else "paddle-runtime.json"
    save_json(output / runtime_report, {
        "paddleocr": version("paddleocr"), "vl": read_json(model_dir / "source.json"),
        "layout": read_json(layout_dir / "source.json"),
        "backend": backend,
        "setupSeconds": round(time.perf_counter() - started, 3),
    })
    for source in inputs:
        report = output / f"paddle-{source.stem}.json"
        if report.exists():
            continue
        print(f"PaddleOCR processing {source.name}", flush=True)
        started = time.perf_counter()
        crop = source.name.startswith("b06-figure-")
        kwargs = {"use_layout_detection": False, "prompt_label": "chart"} if crop else {}
        results = list(model.predict(input=str(source), **kwargs))
        assert len(results) == 1, source
        page = results[0]
        save_json(report, {"imageSha256": sha256(source), "seconds": round(time.perf_counter() - started, 3), "backend": backend,
                           "result": page.json["res"], "markdown": page.markdown.get("markdown_texts", "")})
        print(f"Saved {report.name}", flush=True)


CHOICE_PROMPT = (
    "請獨立解答一道單選題。核對問題問的是正確、錯誤還是最佳選項。"
    "先用簡短文字核對關鍵事實或運算，最後一行只寫 ANSWER: A、ANSWER: B、ANSWER: C 或 ANSWER: D，"
    "字母必須對應你推導的選項。題面不足則最後一行寫 ANSWER: UNKNOWN。\n\n"
)
SOURCE_CHECK_PROMPT = (
    "依據所附的資料和完整題面獨立核對單選題。先判斷問的是正確項、錯誤項還是分類。"
    "問歸屬時，選直接符合所問類別的項目；屬於另一類別的選項要排除。"
    "問錯誤時，優先選與資料事實直接矛盾的陳述；資料沒提到的比較不能據此判成錯誤。"
    "核對選項原句，不假設題目未描述的額外條件。"
    "第一行只輸出 ANSWER: A、ANSWER: B、ANSWER: C 或 ANSWER: D；若證據不足輸出 ANSWER: UNKNOWN。"
    "第二行只寫一句有資料依據的理由。\n\n"
)
REFUTATION_PROMPT = (
    "逐項核對下方 A、B、C、D 的陳述。只看提供的資料。"
    "REFUTED 表示有一項具體事實直接證明該陳述錯誤；SUPPORTED 表示有具體事實直接支持；"
    "沒有提及、一般性推測或措辭絕對，均應填 UNKNOWN。不要替試卷選答案。"
    '只回傳一個 JSON 物件，例如 {"A":"UNKNOWN","B":"SUPPORTED","C":"REFUTED","D":"UNKNOWN"}。\n\n'
)
FIGURE_PROMPTS = {
    "1.1": (
        "Read this directed weighted graph. Return JSON only with keys nodes and edges. "
        "Each edge is [source, target, weight]. The arrowhead is at the target. "
        "Transcribe every visible edge exactly once and preserve its direction and weight."
    ),
    "1.5": (
        "Transcribe this AVL tree as JSON only. Use keys root, nodes and edges. "
        "Each node is [node_label, printed_height], and each edge is [parent_label, child_label, L_or_R]. "
        "Preserve leading zeros in labels. Follow the visible arrow from parent to child. "
        "Read the left or right branch relative to the parent. Include every node and visible edge once."
    ),
}
AVL_PARENT_PROMPT = (
    "Transcribe the numeric AVL search tree as JSON only. Keys root, nodes and edges. "
    "Nodes are [node_label, printed_height]. Edges are [parent_label, child_label]; omit left and right. "
    "Follow the actual connecting arrows, from the parent above to the child below. "
    "Copy numeric labels exactly as printed, including leading zeros. "
    "Include each clearly visible node and edge once. Do not infer missing edges."
)
URJC_PROMPT = (
    "Resuelve el ejercicio de estructuras de datos en español. Responde cada apartado y comprueba el resultado. "
    "Si hay un grafo, comprueba los extremos, la dirección y el peso de cada arista antes de usarla. "
    "Si hay un AVL, distingue alturas de factores de equilibrio y verifica las rotaciones y el árbol final. "
    "Si escribes Pascal, usa las interfaces del enunciado, califica las llamadas a unidades externas y conserva los tipos. "
    "Indica de manera explícita si falta información necesaria.\n\n"
)
PASCAL_PROMPT = (
    "Responde todos los apartados en español. Antes de escribir código, conserva las firmas y nombres del "
    "enunciado. Si el texto transcrito difiere de una declaración visible, sigue la declaración de la imagen. "
    "En records recursivos, declara un tipo puntero antes del record. Desreferencia con ^; si una función "
    "devuelve un puntero nuevo, reserva el nodo y devuelve el puntero. Declara toda rutina antes de llamarla. "
    "Si el enunciado proporciona una unidad, impórtala con uses, usa sus tipos y califica sus llamadas. "
    "No reescribas una interfaz externa ni accedas a su representación. Recorre solo posiciones ocupadas "
    "y trata nodos ausentes y contenedores vacíos. Revisa que cada función asigne su propio resultado. "
    "No repitas el enunciado; prioriza una respuesta completa y breve con un bloque de código por apartado.\n\n"
)


def choice_text(stem, options):
    return stem.strip() + "\n" + "\n".join(f"{label}. {value}" for label, value in options.items())


def clean_moex_cases():
    questions = read_json(MOEX / "official-exam-2020-gold.json")["questions"]
    assert [q["number"] for q in questions] == list(range(1, 41))
    for question in questions:
        stem = question["stem"]
        if question["number"] == 24:
            # The text key ignores indentation; restore the indentation visible on page 3 for solving.
            stem = stem.replace("\nfor b", "\n    for b").replace("\nif a", "\n        if a").replace("\nprint(b)", "\n            print(b)")
        yield {"id": f"moex-clean-{question['number']:02}", "kind": "choice", "text": choice_text(stem, question["options"])}


def figure_cases():
    for number, prompt in FIGURE_PROMPTS.items():
        yield {"id": f"urjc-figure-{number}", "kind": "figure", "text": prompt,
               "images": [str(URJC / f"b06-figure-{number}.png")]}


def run_hunyuan(runtime, output):
    directory = runtime / "hunyuan-gguf"
    binary = runtime / "llama/llama-b12237/llama-mtmd-cli"
    for case in figure_cases():
        report = output / "hunyuan" / (case["id"] + ".json")
        if report.exists():
            continue
        source, = case["images"]
        command = [str(binary), "-m", str(directory / "HunyuanOCR.Q4_K_M.gguf"),
                   "--mmproj", str(directory / "HunyuanOCR.mmproj-q8_0.gguf"),
                   "--image", source, "--jinja",
                   "--n-gpu-layers", "0", "--no-mmproj-offload", "--threads", "4",
                   "-c", "4096", "-n", "768", "--temp", "0", "-p", case["text"]]
        started = time.perf_counter()
        result = subprocess.run(command, capture_output=True, text=True, timeout=180, check=False)
        save_json(report, {"id": case["id"], "model": read_json(directory / "source.json"),
            "raw": result.stdout, "stderr": result.stderr, "returnCode": result.returncode,
            "imageSha256": sha256(Path(source)), "seconds": round(time.perf_counter() - started, 3), "device": "cpu"})
        if result.returncode:
            raise RuntimeError(result.stderr[-1600:])
        print(f"Saved {report.name}", flush=True)


def run_qwen(runtime, output, scope):
    import mlx.core as mx
    from mlx_vlm import generate, load
    from mlx_vlm.prompt_utils import apply_chat_template

    model_dir = runtime / "qwen-4b"
    if scope == "clean":
        cases = list(clean_moex_cases())
    elif scope == "figures":
        cases = list(figure_cases())
    elif scope == "avl-parents":
        tree = next(case for case in figure_cases() if case["id"].endswith("1.5"))
        saved_crop = output / "auto-figure-1.5.png"
        if saved_crop.is_file():
            images = [str(saved_crop)]
        else:
            paper = {question["number"]: question for question in read_json(output / "urjc-ocr-parsed.json")}
            images = paper["1.5"]["images"]
        cases = [{**tree, "text": AVL_PARENT_PROMPT},
                 {**tree, "id": "urjc-auto-figure-1.5", "text": AVL_PARENT_PROMPT, "images": images}]
    elif scope == "auto-figures":
        paper = {question["number"]: question for question in read_json(output / "urjc-ocr-parsed.json")}
        cases = [{"id": f"urjc-auto-figure-{number}", "kind": "figure", "text": prompt,
                  "images": paper[number]["images"]} for number, prompt in FIGURE_PROMPTS.items()]
    elif scope == "retry-choices":
        cases = []
        for path in sorted((output / "qwen").glob("moex-*.json")):
            previous = read_json(path)
            if previous["answer"] is None and previous["generatedTokens"] >= previous["tokenLimit"]:
                cases.append({"id": previous["id"], "kind": "choice", "text": previous["input"],
                              "partial": previous["raw"].rstrip("\ufffd"), "priorTokens": previous["generatedTokens"]})
    elif scope == "urjc-code":
        cases = [case for case in read_json(output / "urjc-e2e-inputs.json")
                 if re.search(r"\b(?:Pascal|record)\b", case["text"], re.I)]
    elif scope == "source-choices":
        from choice_verify import verify
        from concept_sources import sources_for
        cases = [{**case, "sources": sources}
                 for case in [*clean_moex_cases(), *read_json(output / "moex-e2e-inputs.json")]
                 if not verify(case["text"]) and (sources := sources_for(case["text"]))]
    else:
        cases = read_json(output / f"{scope}-inputs.json")
    predictions = output / {"retry-choices": "qwen-retry", "avl-parents": "avl-parents",
                            "urjc-code": "qwen-code", "source-choices": "qwen-source"}.get(scope, "qwen")
    existing = [case for case in cases if not (predictions / (case["id"] + ".json")).exists()]
    if not existing:
        return
    mx.set_cache_limit(256 * 1024 * 1024)
    started = time.perf_counter()
    model, processor = load(str(model_dir))
    save_json(output / f"qwen-runtime-{scope}.json", {"mlx_vlm": version("mlx-vlm"), "model": read_json(model_dir / "source.json"),
        "temperature": 0, "enableThinking": False, "loadSeconds": round(time.perf_counter() - started, 3)})
    for case in existing:
        images = case.get("images", [])
        kind = case["kind"]
        task = {"choice": CHOICE_PROMPT, "figure": "", "urjc": URJC_PROMPT}[kind]
        budget = 640 if scope == "avl-parents" else {"choice": 384, "figure": 768, "urjc": 1800}[kind]
        if scope == "urjc-code":
            task, budget = PASCAL_PROMPT, 2300
        if scope == "source-choices":
            from score import split_options
            body, _ = split_options(case["text"])
            refutation = bool(re.search(r"何者(?:[錯错][誤误]|不正[確确])\s*[？?]$", body))
            task = (REFUTATION_PROMPT if refutation else SOURCE_CHECK_PROMPT)
            task += "資料：\n" + "\n".join(row["fact"] for row in case["sources"]) + "\n\n題面：\n"
            budget = 100
        if scope == "retry-choices":
            budget = 512
        prompt = apply_chat_template(processor, model.config, task + case["text"], num_images=len(images), enable_thinking=False)
        partial = case.get("partial", "")
        started = time.perf_counter()
        result = generate(model, processor, prompt + partial, image=images or None, max_tokens=budget, temperature=0, verbose=False)
        seconds = round(time.perf_counter() - started, 3)
        raw = partial + result.text
        prior_tokens = case.get("priorTokens", 0)
        record = {"id": case["id"], "input": case["text"], "images": [sha256(Path(image)) for image in images],
                  "raw": raw, "seconds": seconds, "promptTokens": result.prompt_tokens,
                  "generatedTokens": prior_tokens + result.generation_tokens, "peakGB": result.peak_memory,
                  "tokenLimit": prior_tokens + budget}
        if prior_tokens:
            record["continuation"] = result.text
        if kind == "choice":
            found = re.findall(r"(?im)^\s*\**ANSWER\**\s*[:：]\s*\**([A-D])\**\s*[.。]?\s*$", raw)
            record["answer"] = found[0].upper() if len(set(found)) == 1 else None
        if scope == "source-choices":
            record["sources"] = case["sources"]
            record["promptVersion"] = "source-choice-v3"
            if refutation:
                record["answer"] = None
                try:
                    obj = json.loads(re.sub(r"^\s*```(?:json)?\s*|\s*```\s*$", "", raw, flags=re.I))
                except ValueError:
                    obj = None
                if isinstance(obj, dict) and set(obj) == set("ABCD") and all(v in ("REFUTED", "SUPPORTED", "UNKNOWN") for v in obj.values()):
                    record["judgments"] = obj
                    rejected = [label for label, value in obj.items() if value == "REFUTED"]
                    if len(rejected) == 1:
                        record["answer"] = rejected[0]
            elif not re.match(r"(?i)^\s*ANSWER\s*[:：]\s*[A-D]\s*\n", raw):
                record["answer"] = None
        save_json(predictions / (case["id"] + ".json"), record)
        print(f"{case['id']}: {record.get('answer') or '-'} ({seconds:.1f}s, {result.generation_tokens} tokens)", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["ocr", "clean", "figures", "auto-figures", "avl-parents", "hunyuan",
                                         "moex-e2e", "urjc-e2e", "urjc-code", "retry-choices", "source-choices"])
    parser.add_argument("output", type=Path)
    parser.add_argument("--runtime", type=Path, default=RUNTIME)
    args = parser.parse_args()
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
    if args.mode == "ocr":
        run_ocr(args.runtime, args.output)
    elif args.mode == "hunyuan":
        run_hunyuan(args.runtime, args.output)
    else:
        run_qwen(args.runtime, args.output, args.mode)


if __name__ == "__main__":
    main()
