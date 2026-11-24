"""CLI entrypoints for prepare_eval.py and run_eval.py."""

from __future__ import annotations

import argparse
import json
import sys
from typing import Sequence

from .prepare import prepare_eval
from .runner import EvalRunError, run_eval


def _print_json(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def prepare_main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="prepare_eval.py",
        description="Clean, repair, slim, and validate raw JSONL into evaluation-ready JSONL.",
    )
    parser.add_argument("-c", "--config", required=True, help="Path to config.yaml")
    parser.add_argument("--raw-input", help="Override prepare.raw_input (file or directory)")
    parser.add_argument("--output", help="Override prepared JSONL output path")
    parser.add_argument("--audit", help="Write line-level audit issues to this JSONL path")
    parser.add_argument("--no-slim", action="store_true", help="Disable lossless prompt-snapshot slimming")
    parser.add_argument("--verify", action="store_true", help="Verify slim/expand lossless round-trip")
    parser.add_argument("--fail-on-reject", action="store_true", help="Exit with code 2 if any record is rejected")
    parser.add_argument("-q", "--quiet", action="store_true", help="Suppress JSON summary on stdout")
    args = parser.parse_args(argv)

    try:
        report = prepare_eval(
            args.config,
            raw_input=args.raw_input,
            output=args.output,
            audit_output=args.audit,
            slim=False if args.no_slim else None,
            verify_slim=True if args.verify else None,
            fail_on_reject=True if args.fail_on_reject else None,
        )
    except EvalRunError as exc:
        if exc.summary is not None and not args.quiet:
            _print_json(exc.summary)
        print(f"Error: {exc}", file=sys.stderr)
        return exc.returncode
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    if not args.quiet:
        _print_json(report)
    return 0


def run_main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="run_eval.py",
        description="Run attribution evaluation from a single YAML config file.",
    )
    parser.add_argument("-c", "--config", required=True, help="Path to config.yaml")
    parser.add_argument("--limit", type=int, help="Evaluate at most N valid cases")
    parser.add_argument("--concurrency", type=int, help="Override execution.concurrency")
    parser.add_argument("--no-resume", action="store_true", help="Ignore existing output and re-evaluate from scratch")
    parser.add_argument("--fail-on-reject", action="store_true", help="Exit with code 2 if any input record is rejected")
    parser.add_argument("-q", "--quiet", action="store_true", help="Suppress progress logs on stderr")
    args = parser.parse_args(argv)

    try:
        summary = run_eval(
            args.config,
            limit=args.limit,
            concurrency=args.concurrency,
            resume=False if args.no_resume else None,
            fail_on_reject=True if args.fail_on_reject else None,
            quiet=args.quiet,
        )
    except EvalRunError as exc:
        if exc.summary is not None:
            _print_json(exc.summary)
        print(f"Error: {exc}", file=sys.stderr)
        return exc.returncode
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    _print_json(summary)
    return 0
