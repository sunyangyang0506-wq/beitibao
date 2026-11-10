"""Verify the local exact solvers with generated and negative-control examples."""

import json
import random

from choice_verify import verify
from run import choice_text
from structured_solve import solve_avl, solve_graph


def check_choices():
    rng = random.Random(20261110)
    evaluated = 0

    def check(stem, expected, distractors, rule):
        nonlocal evaluated
        choices = [expected, *distractors]
        rng.shuffle(choices)
        labels = dict(zip("ABCD", choices, strict=True))
        answer = verify(choice_text(stem, labels))
        assert answer and answer["rule"] == rule and labels[answer["answer"]] == expected, (stem, labels, answer)
        evaluated += 1

    def encode(value, base):
        if not value:
            return "0"
        digits = ""
        while value:
            value, digit = divmod(value, base)
            digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"[digit] + digits
        return digits

    for _ in range(120):
        x, y = rng.sample(range(4, 150), 2)
        bases = rng.sample(range(2, 37), 6)
        stem = f"$({encode(x, bases[0])})_{{{bases[0]}}} \\times ({encode(y, bases[1])})_{{{bases[1]}}}=?$"
        values = [f"({encode(x * y + i, base)})_{{{base}}}" for i, base in enumerate(bases[2:])]
        check(stem, values[0], values[1:], "radix_product")

    for _ in range(80):
        size = rng.randrange(5, 32)
        target = rng.getrandbits(size)
        distances = rng.sample(range(1, size + 1), 4)
        values = []
        for distance in distances:
            mask = sum(1 << i for i in rng.sample(range(size), distance))
            values.append(f"{(target ^ mask):0{size}b}")
        check(f"下列哪個字串與$({target:0{size}b})_2$的漢明距離為{distances[0]}？",
              values[0], values[1:], "hamming")

    for _ in range(80):
        labels = rng.sample(range(1, 900), 16)

        def path_for(goal):
            # The order is the insertion order; following matching partitions finds the true search path.
            remaining = labels[:]
            path = []
            while remaining:
                node, *rest = remaining
                path.append(node)
                if node == goal:
                    return path
                remaining = [v for v in rest if (v < node) == (goal < node)]
            raise AssertionError("missing inserted key")

        deep = [p for goal in labels if len(p := path_for(goal)) > 1]
        good = rng.sample(deep, 3)
        bad = [*good[0], good[0][0]]
        fmt = lambda seq: ", ".join(map(str, seq))
        check("BST 的鍵值介於 0 至 999，何者是不可能的搜尋路徑？",
              fmt(bad), [fmt(seq) for seq in good], "bst_search")

    for _ in range(40):
        symbols = rng.sample(list("ABCDEF"), 3)
        data = "".join(rng.choice(symbols) for _ in range(40))
        index = rng.randint(2, 8)
        dictionary = set(symbols)
        additions = []
        offset = 0
        while offset < len(data):
            prior = max((word for word in dictionary if data.startswith(word, offset)), key=len)
            offset += len(prior)
            if offset < len(data):
                additions.append(prior + data[offset])
                dictionary.add(additions[-1])
        answer = additions[index - 1]
        check(f"用 LZW 壓縮，字母集 {{{', '.join(symbols)}}}，輸入字串 {data}，第{index}個新增詞條是什麼？",
              answer, [v for v in additions if v != answer][:3], "lzw")

    assert verify("$(11)_2\\times(10)_2=?$\nA. (6)_{10}\nB. (110)_2\nC. (7)_{10}\nD. (2)_8") is None
    assert verify("$(11)_2\\times(10)_2=?$\nA. (6)_{10}\nB. (10)_2\nD. (7)_{10}") is None
    assert verify("$(11)_2\\times(10)_2=?$\nA. (6)_{10}\nB. (3)_2\nC. (7)_{10}\nD. (2)_8") is None
    stem = "关于伙伴系统的页分配过程，下列何者错误？"
    for claim in ("伙伴系统内存回收以内核对象为单位。",
                  "Buddy system 分配以 kernel object 為單位",
                  "夥伴系統的記憶體釋放以核心物件為單位"):
        check(stem, claim, ["分配更大的页块需要更高的阶", "空闲块可以分裂", "满足条件的相邻空闲块可以合并"], "buddy_units")
    assert verify(choice_text(stem, {"A": "伙伴系统分配并不是以内核对象为单位",
        "B": "相邻空闲块可以合并", "C": "较高的阶表示更多的页", "D": "空闲块可以分裂"})) is None
    return evaluated


def check_figures():
    stem = 'BFS desde el nodo con la letra “Z”; DFS desde el nodo con la letra “Y”; grado ponderado saliente del nodo con la letra “X”'
    graph = {"nodes": ["W", "X", "Y", "Z"], "edges": [["Z", "Y", 4], ["Z", "X", 3], ["Y", "X", -2], ["X", "Z", 8]]}
    result = solve_graph(stem, json.dumps(graph), json.dumps({**graph, "edges": list(reversed(graph["edges"]))}))
    assert result == {"BFS": ["Z", "X", "Y"], "DFS": ["Y", "X", "Z"], "weightedOutDegree": 8}
    reverse = {**graph, "edges": [*graph["edges"][:-1], ["Z", "X", 8]]}
    try:
        solve_graph(stem, json.dumps(graph), json.dumps(reverse))
    except ValueError:
        pass
    else:
        raise AssertionError("Conflicting arrow accepted")
    tree = {"root": "0020", "nodes": [["0020", 3], ["0010", 2], ["0015", 1], ["0040", 1]],
            "edges": [["0020", "0010"], ["0010", "0015"], ["0020", "0040"]]}
    text = 'árbol AVL tras la eliminación del nodo con valor “0040”'
    result = solve_avl(text, json.dumps(tree), json.dumps(tree))[1]
    assert result == {"root": "0015", "nodes": [["0015", 2], ["0010", 1], ["0020", 1]],
                      "edges": [["0015", "0010", "L"], ["0015", "0020", "R"]]}


if __name__ == "__main__":
    generated = check_choices()
    check_figures()
    print(f"{generated} generated choice cases passed, including label shuffling; conflict and rotation checks passed")
