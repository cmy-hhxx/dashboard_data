"""分类树：意图树来自 taxonomy/intent_2026-10.json，问题树来自数据的 cluster_tree.json。"""

import json
from dataclasses import dataclass


class TreeError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class Node:
    code: str
    label: str
    parent: str | None
    level: int
    order: int
    definition: str | None
    counts_as_error: bool | None


class Tree:
    """一份分类树，带常用的展开能力（大类 → 子孙、编码 → 顶层大类）。"""

    def __init__(self, kind, version, status, released_at, nodes, versions=None, model=None):
        self.kind = kind
        self.version = version
        self.status = status
        self.released_at = released_at
        self.versions = versions or []
        self.model = model
        self.nodes: dict[str, Node] = {n.code: n for n in nodes}
        self._children: dict[str | None, list[str]] = {}
        for node in nodes:
            self._children.setdefault(node.parent, []).append(node.code)
        for parent, codes in self._children.items():
            codes.sort(key=lambda c: (self.nodes[c].order, c))
        self.leaves = {code for code in self.nodes if code not in self._children or not self._children.get(code)}
        self._desc: dict[str, frozenset[str]] = {}

        for node in nodes:
            if node.parent is not None and node.parent not in self.nodes:
                raise TreeError(f"{kind}:{version} 节点 {node.code} 的 parent_code {node.parent} 不存在")

    # -- 查询 ---------------------------------------------------------
    def __contains__(self, code):
        return code in self.nodes

    def node(self, code):
        return self.nodes.get(code)

    def children(self, code):
        return list(self._children.get(code, ()))

    def roots(self):
        return list(self._children.get(None, ()))

    def descendants(self, code):
        """包含自身在内的全部子孙编码。"""
        cached = self._desc.get(code)
        if cached is not None:
            return cached
        out = set()
        stack = [code]
        while stack:
            cur = stack.pop()
            if cur in out:
                continue
            out.add(cur)
            stack.extend(self._children.get(cur, ()))
        result = frozenset(out)
        self._desc[code] = result
        return result

    def l1(self, code):
        """编码所属的顶层大类编码；不认识的编码返回 None。"""
        seen = 0
        cur = code
        while cur in self.nodes and self.nodes[cur].parent is not None:
            cur = self.nodes[cur].parent
            seen += 1
            if seen > 32:
                return None
        return cur if cur in self.nodes else None

    def child_below(self, ancestor, code):
        """返回 ``code`` 在 ``ancestor`` 之下的那一层子节点；不相关时返回 None。"""
        if code == ancestor:
            return code
        cur = code
        seen = 0
        while cur in self.nodes and self.nodes[cur].parent is not None:
            parent = self.nodes[cur].parent
            if parent == ancestor:
                return cur
            cur = parent
            seen += 1
            if seen > 32:
                return None
        return None

    def as_payload(self):
        return {
            "kind": self.kind,
            "version": self.version,
            "status": self.status,
            "released_at": self.released_at,
            "model": self.model,
            "versions": self.versions,
            "nodes": [
                {
                    "code": n.code,
                    "label": n.label,
                    "parent_code": n.parent,
                    "level": n.level,
                    "order": n.order,
                    "definition": n.definition,
                    "counts_as_error": n.counts_as_error,
                }
                for n in self.nodes.values()
            ],
        }


def load_intent(path):
    doc = json.loads(path.read_text(encoding="utf-8"))
    nodes = [
        Node(
            code=item["code"],
            label=item["label"],
            parent=item.get("parent_code"),
            level=int(item.get("level", 1)),
            order=int(item.get("order", 0)),
            definition=item.get("definition"),
            counts_as_error=item.get("counts_as_error"),
        )
        for item in doc["nodes"]
    ]
    versions = doc.get("versions") or [
        {"version": doc["version"], "status": doc.get("status", "current"), "released_at": doc.get("released_at")}
    ]
    return Tree(
        kind="intent",
        version=doc["version"],
        status=doc.get("status", "current"),
        released_at=doc.get("released_at"),
        nodes=nodes,
        versions=versions,
    )


def _walk_cluster(node, out, level, order):
    out.append(
        Node(
            code=node["id"],
            label=node.get("name") or node["id"],
            parent=None,
            level=level,
            order=order,
            definition=node.get("definition") or node.get("plain"),
            counts_as_error=True,
        )
    )
    for idx, child in enumerate(node.get("children") or []):
        _walk_cluster(child, out, level + 1, idx)


def load_cluster(path, model):
    doc = json.loads(path.read_text(encoding="utf-8"))
    meta = doc.get("meta") or {}
    flat: list[Node] = []
    root = doc.get("tree") or {}
    for idx, child in enumerate(root.get("children") or []):
        _walk_cluster(child, flat, 1, idx)

    # 补 parent：_walk_cluster 只带 level，父子关系按树的原始结构重算
    parents: dict[str, str | None] = {}

    def link(node, parent):
        parents[node["id"]] = parent
        for child in node.get("children") or []:
            link(child, node["id"])

    for child in root.get("children") or []:
        link(child, None)

    nodes = [
        Node(
            code=n.code,
            label=n.label,
            parent=parents.get(n.code),
            level=n.level,
            order=n.order,
            definition=n.definition,
            counts_as_error=True,
        )
        for n in flat
    ]
    version = str(meta.get("pipeline_version") or meta.get("version") or "unknown")
    released_at = meta.get("generated_at")
    tree = Tree(
        kind="error",
        version=version,
        status="current",
        released_at=released_at,
        nodes=nodes,
        versions=[{"version": version, "status": "current", "released_at": released_at}],
        model=model,
    )
    return tree
