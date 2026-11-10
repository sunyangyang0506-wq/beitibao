"""Solve supported diagram questions from agreeing transcriptions, then score the readings."""

import argparse
from collections import deque
from dataclasses import dataclass
import json
from pathlib import Path
import re
from time import perf_counter

from run import read_json, save_json
from score import figure_score


def load_reading(raw):
    fence = re.fullmatch(r"\s*```(?:json)?\s*(.*?)\s*```\s*", raw, re.S | re.I)
    return json.loads(fence[1] if fence else raw)


def read_graph(raw):
    data = load_reading(raw)
    if isinstance(data, list):
        edges = [(edge["source"], edge["target"], edge["weight"]) for edge in data]
        nodes = list({node for edge in edges for node in edge[:2]})
    else:
        nodes, edges = data["nodes"], data["edges"]
    if not all(isinstance(node, str) and re.fullmatch(r"[A-Za-z]", node) for node in nodes):
        raise ValueError("Invalid graph labels")
    if not 2 <= len(nodes) <= 100 or not 1 <= len(edges) <= 200 or len(set(nodes)) != len(nodes):
        raise ValueError("Incomplete graph")
    links = {}
    for a, b, w in edges:
        if a not in nodes or b not in nodes or (a, b) in links or not re.fullmatch(r"-?\d{1,9}", str(w)):
            raise ValueError("Invalid graph edge")
        links[a, b] = int(w)
    return set(nodes), links


def solve_graph(stem, first, second):
    nodes, links = read_graph(first)
    if (nodes, links) != read_graph(second):
        raise ValueError("Conflicting graph readings")
    patterns = [r"\b" + op + r" desde el nodo con la letra" for op in ("BFS", "DFS")]
    patterns.append(r"grado ponderado saliente del nodo con la letra")
    starts = [re.findall(pattern + r'\s*[“"]([A-Za-z])[”"]', stem, re.I) for pattern in patterns]
    if not all(len(s) == 1 and s[0] in nodes for s in starts):
        raise ValueError("Unclear graph query")
    bfs_root, dfs_root, source = [s[0] for s in starts]
    neighbors = {node: sorted(b for a, b in links if a == node) for node in nodes}
    bfs, todo, seen = [], deque([bfs_root]), {bfs_root}
    while todo:
        node = todo.popleft()
        bfs.append(node)
        for target in neighbors[node]:
            if target not in seen:
                todo.append(target)
                seen.add(target)
    dfs, todo, seen = [], [dfs_root], set()
    while todo:
        node = todo.pop()
        if node not in seen:
            seen.add(node)
            dfs.append(node)
            todo.extend(reversed(neighbors[node]))
    return {"BFS": bfs, "DFS": dfs, "weightedOutDegree": sum(w for (a, _), w in links.items() if a == source)}


@dataclass
class Node:
    name: str
    left: "Node | None" = None
    right: "Node | None" = None


def height(node):
    return max(height(node.left), height(node.right)) + 1 if node else 0


def read_tree(raw):
    data = load_reading(raw)
    root, nodes, edges = data["root"], data["nodes"], data["edges"]
    if not 2 <= len(nodes) <= 100 or len(edges) != len(nodes) - 1:
        raise ValueError("Incomplete tree")
    names = {}
    printed_heights = {}
    for name, printed in nodes:
        if not isinstance(name, str) or not re.fullmatch(r"-?\d{1,20}", name) or type(printed) is not int or not 1 <= printed <= len(nodes):
            raise ValueError("Unclear node label or height")
        names[name] = Node(name)
        printed_heights[name] = printed
    if len({int(n) for n in names}) != len(nodes) or root not in names:
        raise ValueError("Duplicate or missing node")
    incoming = set()
    for parent, child in edges:
        if parent not in names or child not in names or child in incoming or child == root:
            raise ValueError("Invalid tree edge")
        side = "left" if int(child) < int(parent) else "right"
        if getattr(names[parent], side) is not None:
            raise ValueError("Competing child nodes")
        setattr(names[parent], side, names[child])
        incoming.add(child)
    if set(names) - incoming != {root}:
        raise ValueError("Multiple roots")

    seen = set()

    def validate(node, low, high):
        if not node:
            return 0
        key = int(node.name)
        if node.name in seen or not low < key < high:
            raise ValueError("Ancestor order conflict")
        seen.add(node.name)
        left = validate(node.left, low, key)
        right = validate(node.right, key, high)
        if max(left, right) + 1 != printed_heights[node.name] or abs(left - right) > 1:
            raise ValueError("Height or balance conflict")
        return max(left, right) + 1

    tree = names[root]
    validate(tree, -float("inf"), float("inf"))
    if seen != set(names):
        raise ValueError("Disconnected tree")
    return tree


def tree_payload(tree):
    nodes, edges = [], []

    def visit(node):
        nodes.append([node.name, height(node)])
        for child, side in ((node.left, "L"), (node.right, "R")):
            if child:
                edges.append([node.name, child.name, side])
                visit(child)

    visit(tree)
    return {"root": tree.name, "nodes": nodes, "edges": edges}


def rebalance(tree):
    def rotate_left(node):
        promoted = node.right
        node.right, promoted.left = promoted.left, node
        return promoted

    def rotate_right(node):
        promoted = node.left
        node.left, promoted.right = promoted.right, node
        return promoted

    balance = height(tree.left) - height(tree.right)
    if balance > 1:
        if height(tree.left.left) < height(tree.left.right):
            tree.left = rotate_left(tree.left)
        return rotate_right(tree)
    if balance < -1:
        if height(tree.right.right) < height(tree.right.left):
            tree.right = rotate_right(tree.right)
        return rotate_left(tree)
    return tree


def remove(tree, target):
    if not tree:
        raise ValueError("Target missing")
    key = int(tree.name)
    if target < key:
        tree.left = remove(tree.left, target)
    elif target > key:
        tree.right = remove(tree.right, target)
    elif tree.left and tree.right:
        raise ValueError("Replacement policy unspecified for two children")
    else:
        return tree.left or tree.right
    return rebalance(tree)


def solve_avl(stem, first, second):
    a, b = read_tree(first), read_tree(second)
    evidence = tree_payload(a)
    if evidence != tree_payload(b):
        raise ValueError("Conflicting tree readings")
    keys = re.findall(r'eliminaci[oó]n del nodo con valor\s*[“"](-?\d{1,20})[”"]', stem, re.I)
    if len(keys) != 1 or not re.search(r"\bAVL\b", stem):
        raise ValueError("Unclear deletion query")
    return evidence, tree_payload(remove(a, int(keys[0])))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("original", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    source, output = args.original, args.output
    inputs = {row["id"]: row["text"] for row in read_json(source / "urjc-e2e-inputs.json")}
    start = perf_counter()
    graph_reads = [read_json(source / "qwen" / f"urjc-{kind}figure-1.1.json")["raw"] for kind in ("", "auto-")]
    tree_reads = [read_json(output / "avl-parents" / f"urjc-{kind}figure-1.5.json")["raw"] for kind in ("", "auto-")]
    graph = solve_graph(inputs["urjc-e2e-1.1"], *graph_reads)
    evidence, tree = solve_avl(inputs["urjc-e2e-1.5"], *tree_reads)
    save_json(output / "urjc-structured-solutions.json", {
        "graph": graph, "avl": tree, "validatedAVL": evidence,
        "seconds": round(perf_counter() - start, 4),
        "figure": {"directed": [figure_score(raw, "1.1") for raw in graph_reads],
                   "avlParentsOnly": [figure_score(raw, "1.5") for raw in tree_reads],
                   "avlVerified": figure_score(json.dumps(evidence), "1.5")},
    })


if __name__ == "__main__":
    main()
