#!/usr/bin/env python3
"""Run post-processing human-read translation: python human_read_eval.py -c config.yaml"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from eval_harness.cli import human_read_main

if __name__ == "__main__":
    raise SystemExit(human_read_main())
