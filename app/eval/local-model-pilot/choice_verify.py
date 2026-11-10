"""Exact checks for supported single-choice problems; use no answer key."""

from fractions import Fraction
import re
import unicodedata

from score import split_options


BASE = r"\(([0-9A-Z]+(?:\.[0-9A-Z]+)?)\)_(?:\{(\d{1,2})\}|(\d{1,2}))"
BITS = r"(?:\(([01]{1,120})\)_(?:2|\{2\})|([01]{1,120}))"
LABELS = "ABCD"


def normalized(text):
    text = re.sub(r"([₀-₉]+)", lambda m: "_{" + unicodedata.normalize("NFKC", m[1]) + "}", text)
    return unicodedata.normalize("NFKC", text).replace("$", "").replace("\\times", "×").strip()


def numeral(digits, braced, bare):
    base = int(braced or bare)
    if not 2 <= base <= 36 or len(digits) > 120:
        raise ValueError("invalid numeral")
    integer, sep, decimal = digits.partition(".")
    return Fraction(int(integer, base)) + (Fraction(int(decimal, base), base ** len(decimal)) if sep else 0)


def radix_product(stem, options):
    compact = re.sub(r"\s+", "", stem)
    problem = re.fullmatch(BASE + "×" + BASE + r"=\?", compact, re.I)
    values = [re.fullmatch(BASE, option, re.I) for option in options]
    if not problem or not all(values):
        return None
    result = numeral(*problem.groups()[:3]) * numeral(*problem.groups()[3:])
    return [numeral(*v.groups()) == result for v in values], f"进制换算后相乘，十进制值为 {result}。"


def hamming(stem, options):
    if not re.search(r"[漢汉]明距[離离]|hamming\s+distance", stem, re.I):
        return None
    operands = re.findall(r"\(([01]{2,120})\)_(?:2|\{2\})", stem)
    distance = re.search(r"(?:[為为]|equals|of)\s*(\d{1,3})\s*\??$", stem, re.I)
    values = [re.fullmatch(BITS, option) for option in options]
    if len(operands) != 1 or not distance or not all(values):
        return None
    a = operands[0]
    b = [v[1] or v[2] for v in values]
    if not all(len(x) == len(a) for x in b):
        return None
    counts = [sum(x != y for x, y in zip(a, value)) for value in b]
    return [v == int(distance[1]) for v in counts], "逐位比较，四个选项的不同位数依次是 " + "、".join(map(str, counts)) + "。"


def complement_claim(option):
    pair = re.fullmatch(BASE + r"之([129])的[補补][數数][為为]" + BASE, option, re.I)
    if pair:
        a, a_brace, a_bare, mode, b, b_brace, b_bare = pair.groups()
        base = 10 if mode == "9" else 2
        if int(a_brace or a_bare) != base or int(b_brace or b_bare) != base:
            return None
        if len(a) != len(b) or a.find(".") != b.find(".") or len(a) > 120:
            return None
        value = int(a.replace(".", ""), base)
        limit = base ** len(a.replace(".", ""))
        expected = (-value) % limit if mode == "2" else limit - 1 - value
        return expected == int(b.replace(".", ""), base)
    bcd = re.fullmatch(r"\((\d{1,30})\)_(?:10|\{10\})之BCD[碼码][為为]\(([01]+)\)", option, re.I)
    if bcd:
        return "".join(f"{int(d):04b}" for d in bcd[1]) == bcd[2]
    return None


def complements(stem, options):
    intent = re.fullmatch(r"下列(?:[敘叙][述説说])?何者(正[確确]|[錯错][誤误])\?", re.sub(r"\s+", "", stem))
    if not intent:
        return None
    truth = [complement_claim(re.sub(r"\s+", "", option)) for option in options]
    if any(v is None for v in truth):
        return None
    want_true = intent[1].startswith("正")
    return [v == want_true for v in truth], "按位宽计算补数，并逐个十进制数字核对 BCD 的四位编码。"


def bst_search(stem, options):
    if not re.search(r"\bBST\b|binary\s+search\s+tree|二[叉元](?:搜索|搜尋)[樹树]", stem, re.I):
        return None
    if not re.search(r"(?:不可能|impossible|invalid).{0,24}(?:搜[尋索]|search)", stem, re.I | re.S):
        return None
    seqs = [re.fullmatch(r"-?\d{1,12}(?:\s*,\s*-?\d{1,12}){1,49}", s) for s in options]
    if not all(seqs):
        return None
    limits = re.search(r"(?:介[於于]|between)\s*(-?\d+)\s*(?:[至到]|and)\s*(-?\d+)", stem, re.I)

    def possible(keys):
        if limits and not all(int(limits[1]) <= key <= int(limits[2]) for key in keys):
            return False
        target = keys[-1]
        low, high = -float("inf"), float("inf")
        for index, key in enumerate(keys):
            if not low < key < high:
                return False
            if key == target:
                return index == len(keys) - 1
            if target < key:
                high = key
            else:
                low = key
        return False

    outcomes = [possible(list(map(int, s[0].split(",")))) for s in seqs]
    return [not v for v in outcomes], "用最后一个键作搜索目标，逐步缩小由祖先确定的键值区间。"


def lzw(stem, options):
    if not re.search(r"(?<![a-z0-9])LZW(?![a-z0-9])", stem, re.I) or not re.search(r"[壓压][縮缩]", stem):
        return None
    given = re.search(r"(?:字母|字符|字元)集\s*\{([A-Za-z](?:\s*,\s*[A-Za-z]){1,25})\}[^{}]{0,40}(?:字[串符]|[字碼码]串)\s*([A-Za-z]+)", stem)
    ordinal = re.search(r"第\s*([1-9]\d?|[一二三四五六七八九十]{1,3})\s*[個个項项][^。]{0,20}(?:新[增填]|加入)", stem)
    if not given or not ordinal:
        return None
    digit = {k: i for i, k in enumerate("零一二三四五六七八九")}
    value = ordinal[1]
    if value.isdecimal():
        index = int(value)
    elif "十" in value and value.count("十") == 1:
        left, right = value.split("十")
        index = 10 * digit.get(left or "一", 0) + digit.get(right or "零", 0)
    else:
        index = digit.get(value, 0)
    letters, data = set(re.findall(r"[A-Za-z]", given[1])), given[2]
    if not index or len(data) > 1000 or set(data) - letters or not all(re.fullmatch(r"[A-Za-z]{1,100}", o) for o in options):
        return None
    dictionary, prefix, inserted = set(letters), "", []
    for symbol in data:
        word = prefix + symbol
        if word in dictionary:
            prefix = word
        else:
            dictionary.add(word)
            inserted.append(word)
            if len(inserted) == index:
                return [o == word for o in options], "按首次出现的顺序加入词条：" + "、".join(inserted) + "。"
            prefix = symbol
    return None


def banker(stem, options):
    a = re.search(r"\(allocation\)", stem, re.I)
    m = re.search(r"\(maximum\)", stem, re.I)
    v = re.search(r"\(available\)", stem, re.I)
    if not (a and m and v and a.end() < m.start() < v.start()):
        return None
    if not re.search(r"何者正[確确]\?$", stem):
        return None
    vector = r"\(\s*(\d{1,7}(?:\s*,\s*\d{1,7}){0,19})\s*\)"
    row = r"(?<![A-Za-z0-9])(P\d{1,3})\s*" + vector
    allocations = re.findall(row, stem[a.end():m.start()])
    maxima = re.findall(row, stem[m.end():v.start()])
    available = re.findall(vector, stem[v.end():])

    def matrix(rows):
        return {pid: tuple(map(int, values.split(","))) for pid, values in rows}

    alloc, max_need = matrix(allocations), matrix(maxima)
    if not (2 <= len(alloc) <= 30 and alloc.keys() == max_need.keys() and len(allocations) == len(maxima) == len(alloc) and len(available) == 1):
        return None
    start = tuple(map(int, available[0].split(",")))
    if any(len(x) != len(start) for x in (*alloc.values(), *max_need.values())):
        return None
    need = {pid: [x - y for x, y in zip(max_need[pid], alloc[pid])] for pid in alloc}
    if any(x < 0 for vector in need.values() for x in vector):
        return None

    def safe(sequence):
        if len(sequence) != len(alloc) or set(sequence) != set(alloc):
            return False
        work = list(start)
        for pid in sequence:
            if any(x > y for x, y in zip(need[pid], work)):
                return False
            work = [x + y for x, y in zip(work, alloc[pid])]
        return True

    verdicts = []
    for option in options:
        seq = re.search(r"\(safe sequence\)\s*(P\d{1,3}(?:\s*,\s*P\d{1,3})+)\.?$", option, re.I)
        if seq and re.search(r"安全", option) and not re.search(r"不安全|無法|无法", option):
            verdicts.append(safe([p.strip().upper() for p in seq[1].split(",")]))
        elif re.search(r"[處处]於(?:不安全|死[結结鎖锁])", option) and not re.search(r"不[處处]|不會|不会", option):
            verdicts.append(False)
        else:
            return None
    if sum(verdicts) != 1:
        return None
    return verdicts, "逐个检查最大需求减已分配量是否可满足，程序结束后把已分配资源加回。"


def disk_rpm(stem, options):
    # Positioning excludes transfer time (Operating System Concepts 10e, Ch. 10).
    if not re.search(r"[硬磁][碟盘盤]|hard disk", stem, re.I) or not re.search(r"最接近|closest", stem, re.I):
        return None
    matches = [re.search(r"\(" + term + r"\)[^\d\n]{0,40}(\d+(?:\.\d+)?)\s*ms\b", stem, re.I)
               for term in (r"seek\s*time", r"positioning\s*time")]
    candidates = [re.fullmatch(r"(\d{1,7})\s*RPM", o, re.I) for o in options]
    if not all(matches) or not all(candidates) or not re.search(r"\bRPM\b", stem):
        return None
    seek, positioning = (Fraction(m[1]) for m in matches)
    if positioning <= seek:
        return None
    rpm = 30000 / (positioning - seek)
    distances = [abs(rpm - int(c[1])) for c in candidates]
    return [d == min(distances) for d in distances], f"平均半圈耗时 {float(positioning - seek):g} ms，换算为约 {float(rpm):.1f} RPM。"


def uml_diagrams(stem, options):
    if not re.search(r"unified\s*modeling\s*language|\bUML\b", stem, re.I):
        return None
    intent = re.search(r"(不)?[屬属]於[^?]{0,45}\((structural|structure|behavio[u]?ral|behavio[u]?r) diagrams?\)\s*\?$", stem, re.I)
    if not intent or re.search(r"非[屬属]|何者不是", stem):
        return None
    # Classification from OMG's UML introduction; abstain on unknown diagram types.
    structure = {"class", "object", "component", "composite structure", "package", "deployment", "profile"}
    behavior = {"use case", "activity", "state machine", "statechart", "sequence", "communication", "timing", "interaction overview"}
    names = [re.search(r"\(([a-z ]+) diagram\)$", o, re.I) for o in options]
    if not all(names):
        return None
    normalized_names = [" ".join(n[1].lower().split()) for n in names]
    if not set(normalized_names) <= structure | behavior:
        return None
    group = structure if intent[2].lower().startswith("structur") else behavior
    negated = bool(intent[1])
    return [(name in group) != negated for name in normalized_names], "按 OMG 的 UML 图分类核对每个图名。"


def buddy_units(stem, options):
    # Kernel documentation: the buddy allocator organizes free memory in blocks of pages.
    # An explicit claim about its allocation unit can be checked without judging comparative performance.
    buddy = r"(?:[夥伙]伴系[統统]|buddy\s*system)"
    object_unit = r"(?:核心|內核|内核)[物對对][件象]|kernel\s*object"
    if not re.search(buddy, stem, re.I) or not re.search(r"何者(?:[錯错][誤误]|不正[確确])\s*\?$", stem):
        return None
    if any(re.search(r"以上|全部|都正[確确]|都[錯错]|皆", option) for option in options):
        return None
    claim = (
        rf"^{buddy}(?:\s*\(buddy\s*system\))?(?:之|的)?\s*"
        r"(?:[記记][憶忆][體体]|[內内]存)?(?:分配|回收|收回|[釋释]放)"
        r"(?:(?:[與与和]|及)(?:分配|回收|收回|[釋释]放))?\s*"
        rf"(?:是)?以\s*(?:{object_unit})(?:\s*\(kernel\s*object\))?\s*[為为][單单]位[。.]*$"
    )
    contradictions = [bool(re.fullmatch(claim, option, re.I)) for option in options]
    return contradictions, "伙伴分配器按物理页块分配和合并；内核对象不是它的分配单位。"


RULES = (radix_product, hamming, complements, bst_search, lzw, banker, disk_rpm, uml_diagrams, buddy_units)


def verify(text):
    if len(text) > 8000 or re.search(r"[多複复][選选]|选出所有|select all", text, re.I):
        return None
    if re.findall(r"(?m)^[ \t]*([A-D])\.[ \t]+", text) != list(LABELS):
        return None
    stem, options = split_options(text)
    if tuple(options) != tuple(LABELS) or not all(options.values()):
        return None
    stem = re.sub(r"\s+", " ", normalized(stem))
    values = [normalized(options[label]) for label in LABELS]
    found = []
    for rule in RULES:
        try:
            result = rule(stem, values)
        except (ValueError, ZeroDivisionError):
            continue
        if result and sum(result[0]) == 1:
            found.append({"rule": rule.__name__, "answer": LABELS[result[0].index(True)], "reason": result[1]})
    return found[0] if len(found) == 1 else None
