#!/usr/bin/env python3
"""Eval dashboard server: static files + generated data.json on :5001."""
import json
import mimetypes
import os
import shutil
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
        path = self.path.split("?", 1)[0]
        if path in ("/data.json", "/healthz"):
            policy = "no-store"
        elif path in ("/", "/index.html"):
            policy = "no-cache"
        elif path.startswith("/vendor/") or path == "/echarts.min.js":
            policy = "public, max-age=31536000, immutable"
        else:
            policy = "no-cache"
        self.send_header("Cache-Control", policy)
        super().end_headers()

    def _serve_gzip(self, path):
        gz = path + ".gz"
        try:
            stat = os.stat(gz)
        except OSError:
            return False
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(stat.st_size))
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Last-Modified", self.date_time_string(stat.st_mtime))
        self.end_headers()
        with open(gz, "rb") as fh:
            shutil.copyfileobj(fh, self.wfile)
        self.log_request(200)
        return True

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
        if "gzip" in self.headers.get("Accept-Encoding", ""):
            path = self.translate_path(self.path)
            if os.path.isdir(path):
                index = os.path.join(path, "index.html")
                if os.path.isfile(index):
                    path = index
            if os.path.isfile(path) and os.path.isfile(path + ".gz"):
                self._serve_gzip(path)
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
