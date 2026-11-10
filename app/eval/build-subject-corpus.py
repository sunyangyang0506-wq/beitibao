"""Generate the reproducible Chinese trial corpus and gold labels."""
from hashlib import sha256
from json import dumps
from pathlib import Path

from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen.canvas import Canvas

ROOT = Path(__file__).parent / "subject-corpus"
pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))


def data_structures(n, blind):
    a, b, c = n + 3, n + 7, n + 11
    if blind:
        return [
            (f"完全二叉树有 {2*n+1} 个结点，叶子结点有多少个？", n + 1),
            (f"含 {n+4} 个顶点的无向完全图有多少条边？", (n+4)*(n+3)//2),
            (f"长度为 {2**n} 的有序数组，二分查找最坏需要多少次关键字比较？", n + 1),
        ]
    return [
        (f"空栈依次压入 {a}、{b}、{c}，弹出一次后再读栈顶。栈顶是多少？", b),
        (f"空队列依次入队 {a}、{b}、{c}，连续出队两次。第二次出队的值是多少？", b),
        (f"顺序表已有 {n+4} 个元素，在第 2 个位置插入一个元素。需后移多少个原元素？", n+3),
    ]


def linear_algebra(n, blind):
    if blind:
        return [
            (f"对角矩阵的对角元素为 {n+2}、{n+4}、0。矩阵的秩是多少？", 2),
            (f"求向量 ({n}, 2, 3) 与 (2, 1, 0) 的内积。", 2*n+2),
            (f"二阶矩阵的迹为 {n+9}，一个特征值是 {n+1}，另一特征值是多少？", 8),
        ]
    return [
        (f"矩阵的第一行为 ({n+2}, 1)，第二行为 (3, 4)。行列式是多少？", 4*(n+2)-3),
        (f"线性方程组 x + y = {n+7}，x - y = {n+1}。求 x。", n+4),
        (f"矩阵 A 的第一行为 ({n+1}, 2)，第二行为 (3, 4)。求 3A 的左上角元素。", 3*(n+1)),
    ]


def physics(n, blind):
    if blind:
        return [
            (f"电阻为 {n+3} 欧，通过的电流为 2 安。求电阻两端电压（伏）。", 2*(n+3)),
            (f"一台设备的功率为 {20*n} 瓦，持续工作 5 秒。求能量（焦）。", 100*n),
            (f"波的频率为 {n+2} 赫，波长为 4 米。求传播速度（米每秒）。", 4*(n+2)),
        ]
    return [
        (f"质量为 {n+1} 千克的物体以 3 米每二次方秒加速。求合力（牛）。", 3*(n+1)),
        (f"物体从静止开始，以 2 米每二次方秒加速 {n+2} 秒。求末速度（米每秒）。", 2*(n+2)),
        (f"恒力 {n+5} 牛与位移同向，位移为 3 米。求该力做功（焦）。", 3*(n+5)),
    ]


SUBJECTS = [
    ("data-structures", "数据结构", data_structures),
    ("linear-algebra", "线性代数", linear_algebra),
    ("university-physics", "大学物理", physics),
]


def save_json(path, value):
    path.write_text(dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf8")


for split, count in (("test", 50), ("evaluation", 5)):
    folder = ROOT / split
    folder.mkdir(parents=True, exist_ok=True)
    papers, labels = [], []
    for subject_id, subject, questions in SUBJECTS:
        for number in range(1, count + 1):
            paper_id = f"{subject_id}-{split}-{number:02d}"
            title = f"{subject}  {'评测' if split == 'evaluation' else '测试'}卷 {number:02d}"
            file = folder / f"{paper_id}.pdf"
            pdf = Canvas(str(file), pagesize=(595, 842), invariant=True)
            pdf.setTitle(title)
            pdf.setFont("STSong-Light", 22)
            pdf.drawString(48, 770, title)
            pdf.setFont("STSong-Light", 12)
            pdf.drawString(48, 736, "背题宝合成试卷  |  请填写数值答案，单位以题目要求为准。")
            for index, (stem, answer) in enumerate(questions(number, split == "evaluation"), 1):
                pdf.setFont("STSong-Light", 14)
                pdf.drawString(48, 730 - index * 100, f"{index}. {stem}")
                pdf.line(48, 698 - index * 100, 545, 698 - index * 100)
                labels.append({"id": f"{paper_id}-q{index}", "paperId": paper_id, "page": 1,
                               "kind": "numeric", "prompt": stem, "acceptedAnswers": [str(answer)]})
            pdf.setFont("STSong-Light", 10)
            pdf.drawString(48, 50, "合成工程样本  第 1 页 / 共 1 页")
            pdf.save()
            papers.append({"id": paper_id, "subjectId": subject_id, "title": title, "origin": "synthetic",
                           "sourceGroup": paper_id, "file": file.name, "pageCount": 1,
                           "sha256": sha256(file.read_bytes()).hexdigest()})
    save_json(folder / "manifest.json", {"datasetVersion": "subject-synthetic-v1", "split": split, "papers": papers})
    save_json(folder / "gold.json", {"questions": labels})
