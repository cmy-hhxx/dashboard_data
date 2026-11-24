#!/usr/bin/env python3
"""Standalone CLI entrypoint for internal_eval_service_interface.

Usage:
    python3 run.py serve [--host 0.0.0.0] [--port 5003]
    python3 run.py status
    python3 run.py health
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from internal_eval.api import create_app, serve_standalone  # noqa: E402
from internal_eval.config import load_config  # noqa: E402
from internal_eval.state_store import StateStore  # noqa: E402


def _log(msg: str) -> None:
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}", flush=True)


def cmd_serve(args: argparse.Namespace) -> int:
    cfg = load_config(env_file=args.env_file)
    app = create_app(cfg, start_worker=True)
    serve_standalone(app, host=args.host or cfg.host, port=args.port or cfg.port, log=_log)
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    cfg = load_config(env_file=args.env_file)
    store = StateStore(cfg.state_db_path)
    runs, total = store.list_runs(limit=args.limit, offset=0)
    payload = {
        "config": cfg.public_summary(),
        "total_runs": total,
        "recent_runs": [
            {
                "run_id": r["run_id"],
                "version": r["version"],
                "round_dir_name": r["round_dir_name"],
                "model": r["model"],
                "tier": r["tier"],
                "status": r["status"],
                "created_at": r["created_at"],
                "finished_at": r["finished_at"],
            }
            for r in runs
        ],
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="内部评测与聚类自动化服务")
    parser.add_argument("--env-file", default=None, help="可选独立 env 配置文件路径")
    sub = parser.add_subparsers(dest="command", required=True)

    p_serve = sub.add_parser("serve", help="独立启动 HTTP + 流水线服务")
    p_serve.add_argument("--host", default=None)
    p_serve.add_argument("--port", type=int, default=None)
    p_serve.set_defaults(func=cmd_serve)

    p_status = sub.add_parser("status", help="打印服务配置与最近任务状态")
    p_status.add_argument("--limit", type=int, default=20)
    p_status.set_defaults(func=cmd_status)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
