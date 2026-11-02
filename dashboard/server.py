#!/usr/bin/env python3
"""Eval dashboard server: static files + build.py payloads on :5001, rebuilt on a timer."""
import json
import mimetypes
import os
import shutil
import subprocess
import sys
import threading
import time
from datetime import timezone
from email.utils import parsedate_to_datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
BUILD = os.path.join(HERE, "build.py")
OUTPUTS = [os.path.join(STATIC, n) for n in ("data.json", "samples.json", "samples")]
PORT = int(os.environ.get("PORT", "5001"))
REFRESH = int(os.environ.get("REFRESH_SECONDS", "1800"))

_state = {"last_run": 0, "running": False, "error": "", "seconds": 0, "build": None}
_lock = threading.Lock()


def refresh_once():
    """Rebuild data.json, samples.json and samples/ from the datasets in one pass."""
    with _lock:
        if _state["running"]:
            return
        _state["running"] = True
    started = time.time()
    try:
        proc = subprocess.run(
            [sys.executable, BUILD, "--keep-on-empty"],
            capture_output=True, text=True, timeout=1800, cwd=HERE,
        )
        line = (proc.stdout.strip().splitlines() or [""])[-1]
        if proc.returncode == 0:
            _state["error"] = ""
            try:
                _state["build"] = json.loads(line)
            except ValueError:
                _state["build"] = line[-500:]
            print("[refresh]", line, flush=True)
        else:
            _state["error"] = (proc.stderr or line or "")[-500:]
            print("[refresh] failed:", _state["error"], flush=True)
    except Exception as exc:  # noqa: BLE001 - keep serving the last good build
        _state["error"] = str(exc)
        print("[refresh] error:", exc, flush=True)
    finally:
        _state["seconds"] = round(time.time() - started, 1)
        _state["last_run"] = time.time()
        _state["running"] = False


def scheduler(delay):
    time.sleep(delay)
    while True:
        try:
            refresh_once()
        except Exception as exc:  # noqa: BLE001
            print("[refresh] loop error:", exc, flush=True)
        time.sleep(REFRESH)

class Handler(SimpleHTTPRequestHandler):
    # HTTP/1.1 keeps the connection alive for the many sample-detail requests
    # opened when a multi-trace session is selected.
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC, **kwargs)

    def end_headers(self):
        path = self.path.split("?", 1)[0]
        if path in ("/data.json", "/samples.json"):
            # Revalidate on every load; a 304 still saves the full JSON body.
            policy = "no-cache"
        elif path == "/healthz":
            policy = "no-store"
        elif path in ("/", "/index.html"):
            policy = "no-cache"
        else:
            policy = "no-cache"
        self.send_header("Cache-Control", policy)
        super().end_headers()

    def _gzip_matches_source(self, path, gz):
        """Reject a .gz that was not built from the current source file.

        mtime alone misses equal-timestamp copies (e.g. a copied static tree);
        gzip's trailing ISIZE field records the uncompressed size, so a size
        mismatch catches the dangerous case before stale JSON reaches clients.
        """
        try:
            # gzip preserves the source timestamp, often with coarser precision;
            # allow a small skew but still require a matching payload size below.
            if os.path.getmtime(gz) + 1 < os.path.getmtime(path):
                return False
            with open(gz, "rb") as fh:
                fh.seek(-4, os.SEEK_END)
                size = int.from_bytes(fh.read(4), "little")
            return size == os.path.getsize(path) % (1 << 32)
        except OSError:
            return False

    def _serve_gzip(self, path):
        gz = path + ".gz"
        try:
            stat = os.stat(gz)
            source = os.stat(path)
        except OSError:
            return False
        # The compressed copy must not be older than its source, otherwise a
        # regenerated data.json would be served from a stale .gz.
        last_modified = max(stat.st_mtime, source.st_mtime)
        since = self.headers.get("If-Modified-Since")
        if since:
            try:
                parsed = parsedate_to_datetime(since)
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                if int(last_modified) <= int(parsed.timestamp()):
                    self.send_response(304)
                    self.send_header("Vary", "Accept-Encoding")
                    self.send_header("Last-Modified", self.date_time_string(last_modified))
                    self.end_headers()
                    return True
            except (TypeError, ValueError, OverflowError):
                pass
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(stat.st_size))
        self.send_header("Last-Modified", self.date_time_string(last_modified))
        self.end_headers()
        with open(gz, "rb") as fh:
            shutil.copyfileobj(fh, self.wfile)
        self.log_request(200)
        return True

    def do_GET(self):
        if self.path.startswith("/healthz"):
            body = json.dumps({
                "ok": _state["error"] == "",
                "running": _state["running"],
                "last_refresh": _state["last_run"],
                "refresh_seconds": _state["seconds"],
                "error": _state["error"],
                "build": _state["build"],
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
                if self._gzip_matches_source(path, path + ".gz") and self._serve_gzip(path):
                    return
        super().do_GET()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), fmt % args))


def seed_state():
    """Expose the payload produced by deploy.sh before this process started."""
    try:
        stat = os.stat(OUTPUTS[0])
        with open(OUTPUTS[0], encoding="utf-8") as fh:
            source = json.load(fh).get("source") or {}
        _state["build"] = {"pairs": source.get("pairs"), "pairing": source.get("mode")}
        _state["last_run"] = stat.st_mtime
    except (OSError, ValueError):
        pass


def main():
    if not all(os.path.exists(p) for p in OUTPUTS):
        print("[serve] payloads missing, building once before serving", flush=True)
        refresh_once()
    # Rebuild right away on restart, unless a build just ran (start.sh / deploy.sh build first).
    try:
        age = time.time() - os.path.getmtime(OUTPUTS[0])
    except OSError:
        age = 0
    seed_state()
    threading.Thread(target=scheduler, args=(REFRESH if age < 120 else 0,), daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[serve] http://0.0.0.0:{PORT} static={STATIC} refresh={REFRESH}s", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
