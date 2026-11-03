"""Optional orjson fast path with a stdlib-compatible surface.

orjson is 2–4× faster on the multi-GB JSONL scans.  It is optional: every
deployment keeps working with the standard library, and ``dumps`` falls back
for objects orjson cannot serialize (Counter, sets in payloads, indent, ...).
"""
from __future__ import annotations

import json as _stdlib

try:  # pragma: no cover - depends on the deployment image
    import orjson as _orjson
except ImportError:  # pragma: no cover
    _orjson = None


def loads(value):
    if _orjson is not None:
        return _orjson.loads(value)
    return _stdlib.loads(value)


def dumps(value, ensure_ascii=False, separators=None, indent=None, **kwargs):
    if _orjson is not None and not kwargs:
        option = _orjson.OPT_NON_STR_KEYS
        if indent:
            option |= _orjson.OPT_INDENT_2
        try:
            return _orjson.dumps(value, option=option).decode("utf-8")
        except (TypeError, ValueError):
            pass
    return _stdlib.dumps(value, ensure_ascii=ensure_ascii, separators=separators,
                         indent=indent, **kwargs)
