"""Return bounded Python source positions without importing the inspected program."""

import ast
import json
import re
import sys


source = sys.stdin.read(512 * 1024 + 1)
lines = source.split("\n")
count = 0


def position(line, column, byte_column=True):
    if not 1 <= line <= len(lines):
        return [0, 0]
    text = lines[line - 1]
    prefix = (text.encode("utf-8")[:column].decode("utf-8", errors="ignore") if byte_column else text[:column])
    return [line - 1, len(prefix.encode("utf-16-le")) // 2]


def symbols(nodes, depth=0):
    global count
    if depth > 32:
        return []
    items = []
    for node in nodes:
        if count >= 1200:
            break
        if not isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        count += 1
        kind = ("class" if isinstance(node, ast.ClassDef) else
                "async function" if isinstance(node, ast.AsyncFunctionDef) else "function")
        start = position(node.lineno, node.col_offset)
        end = position(node.end_lineno, node.end_col_offset)
        name = re.search(r"\b(?:class|def)\s+(" + re.escape(node.name) + r")\b", lines[node.lineno - 1])
        selection = [position(node.lineno, name.start(1), False), position(node.lineno, name.end(1), False)] if name else [start, start]
        items.append({"kind": kind, "name": node.name, "range": [start, end], "selection": selection,
                      "children": symbols(node.body, depth + 1)})
    return items


try:
    module = ast.parse(source, filename="<Rocketbrain source>")
    result = {"symbols": symbols(module.body), "truncated": count >= 1200}
except SyntaxError as error:
    location = position(error.lineno or 1, max((error.offset or 1) - 1, 0), False)
    result = {"symbols": [], "error": {"message": error.msg, "position": location}}
print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
