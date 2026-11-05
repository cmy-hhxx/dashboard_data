"""Persistent directory walk for dataset trees on slow (ceph) mounts.

``Path.rglob`` over ``<product>/eval_input`` costs ~50 s on 弗吉尼亚: every
readdir pays per-entry metadata over the network, and the tree is walked from
scratch on every build and every server start even when nothing changed.

The tree rarely changes (a new file per day at most), so keep its shape on disk
- per directory: its ``mtime_ns`` and the names it holds - and only re-list the
directories whose mtime moved.  An unchanged run then costs a handful of stats,
and adding a day touches exactly one directory.

Correctness: on POSIX a directory's mtime changes when an entry is created or
removed, so a cached listing is valid while its mtime matches.  File *content*
changes do not move the directory mtime, which is fine here - callers stat the
files they get back (size + mtime) before trusting any cached content.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

VERSION = 1
# 树清单多久算过期。数据一天才落一次，默认 15 分钟；过期后重走一遍 readdir。
TREE_TTL = 900


class TreeCache:
    """Directory listing cache keyed by a short name (one file per key)."""

    def __init__(self, cache_dir: Path):
        self.dir = Path(cache_dir)

    def _path(self, key: str) -> Path:
        return self.dir / f"tree-{key}.json"

    def _load(self, key: str, root: Path):
        try:
            data = json.loads(self._path(key).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if data.get("version") != VERSION or data.get("root") != str(root):
            return None
        dirs = data.get("dirs")
        return dirs if isinstance(dirs, dict) else None

    def _save(self, key: str, root: Path, dirs):
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            payload = {"version": VERSION, "root": str(root), "dirs": dirs}
            path = self._path(key)
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
            tmp.replace(path)
        except OSError:
            pass

    @staticmethod
    def _mtime_ns(path: Path):
        try:
            return path.stat().st_mtime_ns
        except OSError:
            return None

    @staticmethod
    def _list(path: Path):
        """One readdir: {entry name: 'd'|'f'} plus the directory's own mtime."""
        entries = {}
        try:
            with os.scandir(path) as it:
                for entry in it:
                    try:
                        entries[entry.name] = "d" if entry.is_dir() else "f"
                    except OSError:
                        continue
        except OSError:
            return None
        stamp = TreeCache._mtime_ns(path)
        if stamp is None:
            return None
        return {"m": stamp, "e": entries}

    def walk(self, root: Path, key: str, suffix: str = ".jsonl", skip_parts=(), ttl: int | None = None):
        """Return the ``suffix`` files under ``root`` as paths relative to it.

        ``skip_parts`` prunes whole subtrees by directory name, so an excluded
        folder is never listed at all (not just filtered out afterwards).

        Validation is by age, not by stat: isolated stats on ceph cost about as
        much as the walk itself (the readdir is what fills the attr cache), so
        re-checking every directory would throw the win away.  ``ttl=None``
        means "use the tree at once, we just wrote it"; the default comes from
        TREE_TTL seconds.
        """
        root = Path(root)
        if not root.is_dir():
            return []
        dirs = self._load(key, root)
        age = self._age(key)
        if dirs is not None and age is not None and age < (TREE_TTL if ttl is None else ttl):
            return self._collect(dirs, suffix)
        dirty = dirs is None
        dirs = dirs if dirs is not None else {}

        seen = set()
        stack = [""]
        while stack:
            rel = stack.pop()
            seen.add(rel)
            path = root / rel if rel else root
            meta = self._list(path)
            if meta is None:
                dirs.pop(rel, None)
                continue
            dirs[rel] = meta
            dirty = True
            for name, kind in meta["e"].items():
                if kind != "d" or name in skip_parts:
                    continue
                stack.append(f"{rel}/{name}" if rel else name)

        for rel in [r for r in dirs if r not in seen]:
            dirs.pop(rel)
        if dirty:
            self._save(key, root, dirs)
        return self._collect(dirs, suffix)

    @staticmethod
    def _collect(dirs, suffix):
        out = []
        for rel, meta in dirs.items():
            for name, kind in meta["e"].items():
                if kind != "f" or not name.endswith(suffix):
                    continue
                out.append(f"{rel}/{name}" if rel else name)
        return sorted(out)

    def _age(self, key: str):
        try:
            return time.time() - self._path(key).stat().st_mtime
        except OSError:
            return None
