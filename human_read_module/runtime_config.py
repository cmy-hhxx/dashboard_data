"""Hot-reloadable runtime config (RPM cap, workers, pause switch) with zero restart required.

Default config file lives at:
    <human_read_root>/.state/runtime_config.json

Edit ``target_rpm`` (or ``paused: true``) on disk and the running daemon picks it up
within ~5 seconds automatically; ``workers`` takes effect on the next file.
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

DEFAULT_RUNTIME_CONFIG: dict[str, Any] = {
    "target_rpm": 40,
    "workers": 16,
    "paused": False,
}

_LOCK = threading.Lock()
_CFG_PATH: Path | None = None
_LAST_CHECK = 0.0
_LAST_MTIME_NS = -1
_CACHED: dict[str, Any] = dict(DEFAULT_RUNTIME_CONFIG)


def init_runtime_config(path: Path | str, initial_overrides: dict[str, Any] | None = None) -> Path:
    """Bind the runtime config path; creates the file with defaults if it does not exist yet."""
    global _CFG_PATH, _LAST_CHECK, _LAST_MTIME_NS, _CACHED
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    if not p.is_file():
        data = dict(DEFAULT_RUNTIME_CONFIG)
        if initial_overrides:
            for k, v in initial_overrides.items():
                if v is not None and k in data:
                    data[k] = v
        p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with _LOCK:
        _CFG_PATH = p
        _LAST_CHECK = 0.0
        _LAST_MTIME_NS = -1
        _CACHED = dict(DEFAULT_RUNTIME_CONFIG)
    reload_if_changed(force=True)
    return p


def reload_if_changed(force: bool = False) -> dict[str, Any]:
    """Check mtime every 5s and hot-reload JSON config if modified."""
    global _LAST_CHECK, _LAST_MTIME_NS, _CACHED
    now = time.monotonic()
    with _LOCK:
        p = _CFG_PATH
        if p is None:
            return dict(_CACHED)
        if not force and now - _LAST_CHECK < 5.0:
            return dict(_CACHED)
        _LAST_CHECK = now
        try:
            mtime_ns = p.stat().st_mtime_ns
        except OSError:
            return dict(_CACHED)
        if not force and mtime_ns == _LAST_MTIME_NS:
            return dict(_CACHED)
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return dict(_CACHED)
        if isinstance(raw, dict):
            merged = dict(DEFAULT_RUNTIME_CONFIG)
            for k in DEFAULT_RUNTIME_CONFIG:
                if k in raw and raw[k] is not None:
                    merged[k] = raw[k]
            old_rpm, old_paused = _CACHED.get("target_rpm"), _CACHED.get("paused")
            _CACHED = merged
            _LAST_MTIME_NS = mtime_ns
            if not force and (merged.get("target_rpm") != old_rpm or merged.get("paused") != old_paused):
                print(
                    f"[human_read] Hot-reloaded {p}: target_rpm={merged['target_rpm']} "
                    f"workers={merged['workers']} paused={merged['paused']}",
                    flush=True,
                )
        return dict(_CACHED)


def live_target_rpm(fallback: int) -> int:
    with _LOCK:
        if _CFG_PATH is None:
            return fallback
    cfg = reload_if_changed()
    try:
        return int(cfg.get("target_rpm", fallback))
    except (TypeError, ValueError):
        return fallback


def is_paused() -> bool:
    with _LOCK:
        if _CFG_PATH is None:
            return False
    return bool(reload_if_changed().get("paused", False))
