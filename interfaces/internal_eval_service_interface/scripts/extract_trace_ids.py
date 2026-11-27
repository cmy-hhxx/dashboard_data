#!/usr/bin/env python3
"""Extract deduplicated trace IDs from HTML briefing / TXT / JSONL for `POST /api/v1/internal-eval/runs`."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

_TRACE_RE = re.compile(r"\b(?:2000\d{28}|[0-9a-f]{32})\b")
_LI_RE = re.compile(r"<li>\s*([0-9A-Za-z_-]{16,64})\s*</li>")


def extract_trace_ids(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8", errors="replace")
    suffix = path.suffix.lower()
    raw_ids: list[str] = []
    if suffix in (".html", ".htm"):
        raw_ids = _LI_RE.findall(text)
    elif suffix == ".jsonl":
        for line in text.splitlines():
            s = line.strip()
            if not s:
                continue
            try:
                obj = json.loads(s)
            except ValueError:
                continue
            if isinstance(obj, dict):
                tid = str(obj.get("trace_id") or (obj.get("meta") or {}).get("trace_id") or "").strip()
                if tid:
                    raw_ids.append(tid)
    if not raw_ids:
        raw_ids = _TRACE_RE.findall(text)
    return list(dict.fromkeys(x.strip() for x in raw_ids if x.strip()))


def main() -> int:
    ap = argparse.ArgumentParser(description="Extract trace_ids for internal-eval extra_traces")
    ap.add_argument("input_file", type=Path, help="HTML briefing / TXT / JSONL file")
    ap.add_argument("--limit", type=int, default=0, help="Optional cap on returned trace_ids")
    ap.add_argument("--output", type=Path, default=None, help="Optional JSON output file")
    args = ap.parse_args()

    ids = extract_trace_ids(args.input_file)
    if args.limit > 0:
        ids = ids[: args.limit]
    text = json.dumps(ids, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
