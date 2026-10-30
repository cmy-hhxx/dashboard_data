#!/usr/bin/env python3
"""Eval dashboard server: static files + generated data.json on :5001."""
import json
import os
import subprocess
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
PREPARE = os.path.join(HERE, "prepare.py")
COUNTS = os.path.join(HERE, "cache", "datasets.json")
SCAN = os.path.join(HERE, "scan_datasets.py")
PORT = int(os.environ.get("PORT", "5001"))
REFRESH = int(os.environ.get("REFRESH_SECONDS", "1800"))

_state = {"last_run": 0, "running": False, "error": "", "seconds": 0}
_lock = threading.Lock()


def refresh_once():
    with _lock:
        if _state["running"]:
            return
        _state["running"] = True
    started = time.time()
    try:
        scan = subprocess.run([sys.executable, SCAN], capture_output=True, text=True, timeout=1800)
        if scan.returncode != 0:
            print("[refresh] scan failed:", (scan.stderr or "")[-500:], flush=True)
            scan = None
        proc = subprocess.run(
            [sys.executable, PREPARE, "--counts", COUNTS],
            capture_output=True, text=True, timeout=1800,
        )
        if proc.returncode == 0:
            _state["error"] = ""
            print("[refresh]", proc.stdout.strip(), flush=True)
        else:
            _state["error"] = (proc.stderr or "")[-500:]
            print("[refresh] failed:", _state["error"], flush=True)
    except Exception as exc:  # noqa: BLE001 - keep serving regardless
        _state["error"] = str(exc)
        print("[refresh] error:", exc, flush=True)
    finally:
        _state["seconds"] = round(time.time() - started, 1)
        _state["last_run"] = time.time()
        _state["running"] = False


def scheduler():
    if os.environ.get("DISABLE_REFRESH") == "1":
        return
    while True:
        try:
            refresh_once()
        except Exception as exc:  # noqa: BLE001
            print("[refresh] loop error:", exc, flush=True)
        time.sleep(REFRESH)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path.startswith("/healthz"):
            body = json.dumps({
                "ok": _state["error"] == "",
                "last_refresh": _state["last_run"],
                "refresh_seconds": _state["seconds"],
                "error": _state["error"],
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), fmt % args))


def main():
    if not os.path.exists(os.path.join(STATIC, "data.json")):
        print("[serve] data.json missing, building once", flush=True)
        refresh_once()
    threading.Thread(target=scheduler, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[serve] http://0.0.0.0:{PORT} static={STATIC} refresh={REFRESH}s", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
