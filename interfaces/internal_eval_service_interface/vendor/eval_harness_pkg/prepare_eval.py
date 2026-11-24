#!/usr/bin/env python3
"""Prepare and clean raw evaluation data: python prepare_eval.py -c config.yaml"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from eval_harness.cli import prepare_main

if __name__ == "__main__":
    raise SystemExit(prepare_main())
