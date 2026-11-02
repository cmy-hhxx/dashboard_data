#!/usr/bin/env python3
"""对话分析查询接口 v1.0 —— 本地/远端入口。

    python3 run.py build     # 只建索引（部署前预检）
    python3 run.py serve     # 建索引后启动 HTTP 服务（默认 0.0.0.0:5003）
    python3 run.py status    # 打印当前索引摘要
"""

import argparse
import json
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from analysis_api import config, server, store, snapshot  # noqa: E402
from analysis_api.taxonomy import load_cluster, load_intent  # noqa: E402


def _log(message):
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}", flush=True)


def command_build(_args):
    summary = store.build(log=_log)
    _log("[build] " + json.dumps(summary, ensure_ascii=False))
    return 0


def command_status(args):
    if not config.db_path().exists():
        _log(f"[status] 索引不存在：{config.db_path()}")
        return 1
    conn = store.connect(config.db_path())
    try:
        intent = load_intent(config.INTENT_TAXONOMY_FILE)
        trees = {}
        for model_dir, (tree_path, _) in store.cluster_files(config.datasets_root() / config.AIME_DIR).items():
            suffix = config.MODEL_SUFFIX.get(model_dir, model_dir)
            trees[f"__{suffix}"] = load_cluster(tree_path, model_dir)
        snap = snapshot.load(conn, intent, trees)
        server.APP._fix_app_versions(snap)
        payload = {
            "traces": len(snap.traces),
            "data_updated_at": snap.data_updated_at,
            "intent_version": snap.intent.version if snap.intent else None,
            "error_trees": {app: tree.version for app, tree in snap.errors.items()},
            "app_versions": sorted({t.app_version for t in snap.traces}),
            "sources": sorted({t.source for t in snap.traces}),
            "days": sorted({t.day for t in snap.traces}),
            "db": str(config.db_path()),
        }
        _log(json.dumps(payload, ensure_ascii=False, indent=1))
    finally:
        conn.close()
    return 0


def _background_build():
    """先同步建一次索引，之后按 REFRESH_SECONDS 周期重建。"""
    started = time.time()
    server.APP.rebuild(log=_log)
    _log(f"[serve] 索引就绪，用时 {round(time.time() - started, 1)}s")
    while True:
        time.sleep(config.REFRESH_SECONDS)
        server.APP.rebuild(log=_log)


def command_serve(args):
    thread = threading.Thread(target=_background_build, daemon=True)
    thread.start()
    server.serve(host=args.host, port=args.port, log=_log)
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="对话分析查询接口 v1.0")
    sub = parser.add_subparsers(dest="command", required=True)

    build = sub.add_parser("build", help="只构建索引")
    build.set_defaults(func=command_build)

    status = sub.add_parser("status", help="打印索引摘要")
    status.set_defaults(func=command_status)

    serve = sub.add_parser("serve", help="构建索引并启动服务")
    serve.add_argument("--host", default=config.HOST)
    serve.add_argument("--port", type=int, default=config.PORT)
    serve.set_defaults(func=command_serve)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
